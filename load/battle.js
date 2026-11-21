// 실시간 대결 부하 테스트 (k6). 사용법은 README의 "부하 테스트" 참고.
//   k6 run -e BASE_URL=https://... -e TOKENS=tokens.json -e SCENARIO=match load/battle.js
//   SCENARIO=match: 빠른 1:1 매칭으로 짝지어 끝까지 (VUS명, ITERATIONS판씩)
//   SCENARIO=room : ROOM_SIZE명씩 방을 만들어 동시에 시작 (반 전체 대결)
import { check, fail, sleep } from 'k6';
import { SharedArray } from 'k6/data';
import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';
import ws from 'k6/ws';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const SCENARIO = __ENV.SCENARIO || 'match';
const VUS = Number(__ENV.VUS || 200);
const ITERATIONS = Number(__ENV.ITERATIONS || 3);
const ROOM_SIZE = Number(__ENV.ROOM_SIZE || 30);
const ROOMS = Number(__ENV.ROOMS || 6);
/** 답을 고르는 데 걸리는 시간 (사람처럼 0.5~4초) */
const THINK_MIN_MS = 500;
const THINK_MAX_MS = 4000;
const BATTLE_TIMEOUT_MS = 5 * 60 * 1000;
const START_FALLBACK_MS = 60 * 1000;

const tokens = new SharedArray('tokens', () => JSON.parse(open(__ENV.TOKENS || 'tokens.json')));

const matchWait = new Trend('match_wait_ms', true);
const answerAck = new Trend('answer_ack_ms', true);
const questionDelay = new Trend('question_delivery_ms', true);
const battlesFinished = new Counter('battles_finished');
const matchTimeouts = new Counter('match_timeouts');
const serverErrors = new Counter('server_errors');

const thresholds = {
  answer_ack_ms: ['p(95)<300'],
  question_delivery_ms: ['p(95)<500'],
  server_errors: ['count<10'],
  http_req_failed: ['rate<0.01'],
};

export const options =
  SCENARIO === 'room'
    ? {
        scenarios: {
          room: {
            executor: 'per-vu-iterations',
            vus: ROOM_SIZE * ROOMS,
            iterations: 1,
            maxDuration: '10m',
          },
        },
        setupTimeout: '2m',
        thresholds,
      }
    : {
        scenarios: {
          match: {
            executor: 'per-vu-iterations',
            vus: VUS,
            iterations: ITERATIONS,
            maxDuration: '20m',
          },
        },
        thresholds: { ...thresholds, match_wait_ms: ['p(95)<5000'] },
      };

// 앱 버전 검사를 통과하도록 웹 클라이언트로 보낸다 (최소 버전보다 낮으면 426)
const CLIENT_VERSION = __ENV.CLIENT_VERSION || '99.0.0';

const auth = (token) => ({
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-Client-Platform': 'WEB',
    'X-Client-Version': CLIENT_VERSION,
  },
});

function tokenOf(index) {
  if (index >= tokens.length) fail(`토큰이 모자랍니다 (${tokens.length}개, ${index + 1}번째 필요)`);
  return tokens[index].token;
}

function ticketUrl(token) {
  const res = http.post(`${BASE_URL}/realtime/ticket`, null, auth(token));
  if (!check(res, { 'ticket 200': (r) => r.status === 200 })) return null;
  const body = res.json();
  return `${__ENV.WS_URL || body.wsUrl}?ticket=${body.ticket}`;
}

/**
 * 한 판을 끝까지 한다. 문항마다 생각하는 시간 뒤 아무 보기나 고르고, 끝나면 결과를 조회한다.
 * onOpen에서 매칭 요청이나 방 구독을, onMessage로 시나리오별 메시지를 처리한다
 */
function play(token, { onOpen, onMessage }) {
  const url = ticketUrl(token);
  if (!url) return;
  const sentAt = {};
  ws.connect(url, {}, (socket) => {
    const send = (type, payload) => socket.send(JSON.stringify({ type, requestId: null, payload }));
    socket.on('open', () => onOpen(send, socket));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw);
      const { type, payload } = message;
      if (type === 'QUESTION_STARTED') {
        questionDelay.add(Date.now() - Date.parse(message.serverTime));
        const think = THINK_MIN_MS + Math.random() * (THINK_MAX_MS - THINK_MIN_MS);
        socket.setTimeout(() => {
          sentAt[payload.questionIndex] = Date.now();
          send('ANSWER_SUBMIT', {
            questionIndex: payload.questionIndex,
            choiceIndex: Math.floor(Math.random() * 4),
          });
        }, think);
      } else if (type === 'ANSWER_ACCEPTED') {
        const at = sentAt[payload.questionIndex];
        if (at) answerAck.add(Date.now() - at);
      } else if (type === 'BATTLE_FINISHED') {
        const res = http.get(`${BASE_URL}/battles/${payload.battleId}/result`, auth(token));
        check(res, { 'result 200': (r) => r.status === 200 });
        battlesFinished.add(1);
        socket.close();
      } else if (type === 'ROOM_CLOSED') {
        socket.close();
      } else if (type === 'ERROR') {
        serverErrors.add(1, { code: payload.code });
      }
      onMessage(message, send, socket);
    });
    socket.on('error', () => serverErrors.add(1, { code: 'WS_ERROR' }));
    socket.setTimeout(() => socket.close(), BATTLE_TIMEOUT_MS);
  });
}

function quickMatch() {
  const token = tokenOf(__VU - 1);
  let queuedAt = 0;
  play(token, {
    onOpen: () => {
      queuedAt = Date.now();
      const res = http.post(`${BASE_URL}/battles/matchmaking`, null, auth(token));
      check(res, { 'matchmaking 202': (r) => r.status === 202 });
    },
    onMessage: ({ type, payload }, send, socket) => {
      if (type === 'MATCH_FOUND') {
        matchWait.add(Date.now() - queuedAt);
        send('ROOM_SUBSCRIBE', { roomId: payload.roomId });
      } else if (type === 'MATCH_TIMEOUT') {
        matchTimeouts.add(1);
        socket.close();
      }
    },
  });
  sleep(1 + Math.random() * 2);
}

/** 방마다 첫 번째 사용자가 방장. 기본 단어팩으로 방을 미리 만들어 둔다 */
export function setup() {
  if (SCENARIO !== 'room') return {};
  const any = tokenOf(0);
  const packs = http.get(`${BASE_URL}/packs?type=DEFAULT&size=50`, auth(any)).json();
  const pack = (packs.items || []).find((p) => p.wordCount >= 10);
  if (!pack) fail('단어 10개 이상인 기본 단어팩이 없습니다');
  const rooms = [];
  for (let r = 0; r < ROOMS; r++) {
    const res = http.post(
      `${BASE_URL}/battles/rooms`,
      JSON.stringify({
        packId: pack.packId,
        questionType: 'KO_TO_EN_CHOICE',
        questionCount: 10,
        timeLimitSec: 10,
        maxParticipants: ROOM_SIZE,
      }),
      auth(tokenOf(r * ROOM_SIZE)),
    );
    if (res.status !== 201) fail(`방 만들기 실패 (${res.status} ${res.body})`);
    rooms.push(res.json());
  }
  return { rooms };
}

function classRoom(data) {
  const index = __VU - 1;
  const room = data.rooms[Math.floor(index / ROOM_SIZE)];
  const isHost = index % ROOM_SIZE === 0;
  const token = tokenOf(index);
  if (!isHost) {
    const res = http.post(`${BASE_URL}/battles/rooms/${room.inviteCode}/join`, null, auth(token));
    check(res, { 'join 200': (r) => r.status === 200 });
  }
  let started = false;
  let joined = 0;
  const start = (send) => {
    if (started) return;
    started = true;
    send('ROOM_START', { roomId: room.roomId });
  };
  play(token, {
    onOpen: (send, socket) => {
      send('ROOM_SUBSCRIBE', { roomId: room.roomId });
      // 다 모이지 않아도 1분 뒤에는 시작한다
      if (isHost) socket.setTimeout(() => start(send), START_FALLBACK_MS);
    },
    onMessage: ({ type, payload }, send) => {
      if (!isHost || started) return;
      if (type === 'ROOM_STATE') joined = payload.room.participants.length;
      if (type === 'PARTICIPANT_JOINED') joined += 1;
      // 모두 들어오면 방장이 시작한다
      if (joined >= ROOM_SIZE) start(send);
    },
  });
}

export default function (data) {
  if (SCENARIO === 'room') classRoom(data);
  else quickMatch();
}
