# 대결

## 실시간 (WebSocket)

- `POST /realtime/ticket`으로 1회용 티켓(30초, Valkey `ws:ticket:{ticket}`)을 받아 `{wsUrl}?ticket=`으로 접속합니다. 접속할 때 `GETDEL`로 꺼내므로 다시 쓸 수 없고, 틀리면 4401로 끊습니다.
- `@nestjs/platform-ws`의 `WsAdapter`로 Fastify와 같은 포트의 `/ws`에 붙습니다. 메시지는 최대 16KB입니다.
- 메시지 형식은 `{ type, requestId, payload }`이고 서버가 보낼 때 `serverTime`을 붙입니다. 실패는 `ERROR { code, message }`이며 받은 `requestId`를 돌려줍니다.
  - `WS_BAD_MESSAGE`: JSON이 아니거나 type이 없음
  - `WS_UNKNOWN_TYPE`: 등록되지 않은 type
  - `INVALID_REQUEST`: payload 검증 실패
  - `RATE_LIMITED`: 10초에 30개 초과(첫 번째 초과에만 알리고 나머지는 버림)
- 기능 모듈은 `RealtimeService.handle(type, zod 스키마, 처리기)`로 메시지 처리기를 등록합니다. 요청에 대한 답은 `ctx.reply()`로 보내 그 연결에만(같은 사용자의 다른 탭 제외) 가고, 서버 쪽 알림은 `sendToUsers(userIds, type, payload)`로 사용자의 모든 연결에 보냅니다. 보내기는 Valkey pub/sub(`rt:deliver`)을 거쳐 사용자가 붙어 있는 인스턴스에서 전달되므로 서버가 여러 대여도 됩니다.
- 티켓 확인 전에 도착한 메시지는 모아 두었다가 처리하고, 한 연결의 메시지는 받은 순서대로 하나씩 처리합니다.
- 서버가 30초마다 ping을 보내고 다음 ping까지 pong이 없으면 끊습니다. 접속 상태는 `ws:online:{userId}` 해시에 인스턴스별 연결 수로 남습니다(90초, ping마다 연장). 폰·웹처럼 여러 인스턴스에 붙은 사용자는 한쪽이 끊겨도 접속 중으로 남습니다.

## 대결방

- 대기 중인 방은 MySQL(`battle_rooms`, `battle_room_participants`)에 둡니다. 참가는 방 행을 잠가(`FOR UPDATE`) 정원 확인과 참가를 한 번에 처리합니다. 같은 방 참가는 서버 안에서 먼저 줄을 세워(`KeyedSerializer`) 잠금을 기다리는 동안 DB 연결을 붙잡지 않게 하고, 반 소속 확인은 잠금 밖에서 합니다.
- 사용자당 활성 방 하나는 참가자의 생성 컬럼 `active_user = IF(active, user_id, NULL)` 유니크로 막습니다. 생성·참가·매칭·다시 하기가 모두 같은 제약을 씁니다. 초대 코드(영문 대문자·숫자 6자리)는 진행 중인 방끼리만 겹치지 않게 `active_code` 유니크로 막습니다.
- 30분 안에 시작하지 않은 방은 BullMQ `battle` 큐의 지연 작업(`expire-room`, 실패하면 5번까지 재시도)으로 닫고 `ROOM_CLOSED { reason: EXPIRED }`를 보냅니다.
  - 방 상태와 참가자 비우기는 한 트랜잭션입니다. 나눠 하면 그 사이에 실패했을 때 참가자가 끝난 방에 묶입니다.
  - 작업이 늦어져도 조회·참가·생성 때 만료 시각을 보고 닫습니다. 끝난 방에 활성으로 남은 참가 기록도 참가·생성 때 풀어 줍니다.
- 참가하면 방에 있던 사람(교사용 방은 진행자 포함)에게 `PARTICIPANT_JOINED`를 보냅니다.
- 초대 코드를 연달아 5번 잘못 넣으면(형식 오류·없는 방·끝난 방) 1분 동안 429 `ROOM_CODE_ATTEMPTS_EXCEEDED`(`Retry-After: 60`)입니다. 조회(`GET`)와 참가가 같은 횟수를 쓰고, 참가에 성공해야 다시 셉니다(아는 옛날 코드로 초기화할 수 없게).
- 교사용 반 방(`POST /classes/{classId}/rooms`)의 교사는 진행자라 참가자·인원에 들어가지 않고, 진행 중인 반 방은 교사당 하나입니다(교사 행을 잠가 동시에 만들어도 하나만). 담당 반이 아니면 403 `CLASS_NOT_ASSIGNED`이고, 그 반 학생만 들어올 수 있습니다.
- `Room.battleId`는 대결이 끝난 뒤 결과 조회용으로 채웁니다(대결 진행 작업에서).

### 대기실 (WebSocket)

- `ROOM_SUBSCRIBE { roomId }`: 참가자(교사용 방은 진행자도)만 구독할 수 있고, 답으로 `ROOM_STATE { room }`을 받습니다. 끊겼다 돌아온 참가자는 다시 `CONNECTED`가 되고 나머지에게 `PARTICIPANT_STATE`를 보냅니다.
- 모든 인스턴스에서 연결이 끊기면 대기실 참가자는 `DISCONNECTED`로만 표시하고 방에 남깁니다(`RealtimeService.onUserGone`).
- `ROOM_LEAVE`: 진행 중에도 나갈 수 있고, 나간 사람을 포함해 `PARTICIPANT_STATE { LEFT }`를 보냅니다.
  - 방장이 나가면 가장 먼저 들어온 참가자가 방장이 됩니다(`HOST_CHANGED`). 방장 판단은 방의 `host_user_id` 기준이고, 나갔다 다시 들어온 옛 방장의 `is_host`는 지웁니다.
  - 모두 나가면 방을 닫고, 교사용 방에서 진행자가 나가면 `ROOM_CLOSED { HOST_LEFT }`로 닫습니다.
- `ROOM_KICK { roomId, userId }`: 방장만, 대기실에서만 합니다. 강퇴된 사람에게는 `ROOM_CLOSED { KICKED }`, 나머지에게는 `PARTICIPANT_STATE { KICKED }`를 보냅니다.
- `ROOM_START`: 방장만, 참가자 2명 이상일 때 `COUNTDOWN`으로 바꾸고 `COUNTDOWN_STARTED { startsAt }`(3초 뒤)를 보냅니다.
  - BullMQ 지연 작업(`start-battle`)이 3초 뒤 `IN_PROGRESS`로 바꾸고 `ROOM_STATE`를 보냅니다.
  - 그사이 인원이 2명 아래가 되면 `COUNTDOWN_CANCELLED { NOT_ENOUGH_PARTICIPANTS }`와 함께 대기실로 돌아갑니다.
  - 예약에 실패하면 카운트다운이 끝나지 않으므로 대기실로 되돌립니다.
  - 끝나는 시각을 `countdown_ends_at`에 저장하고 작업에도 담아, 취소 뒤 다시 시작했을 때 예전 작업이 새 카운트다운을 일찍 끝내지 않게 합니다.
  - 카운트다운 중에 만료 작업이 돌면 지우지 않고 1분 뒤 다시 확인합니다. 그때 시작 작업이 유실돼 멈춰 있으면 대기실로 돌립니다.
  - 예약하는 사이 취소됐으면 `COUNTDOWN_STARTED`를 보내지 않습니다(취소 알림 뒤에 시작 알림이 도착하지 않게). 시작한 뒤 알림에 실패해 작업이 다시 돌면 `ROOM_STATE`만 다시 보냅니다.
- 멈춘 방 정리: 참가·방 만들기(교사는 진행 중인 방 기준) 때, 카운트다운이 끝나고 30초가 지나도 시작되지 않은 방은 `COUNTDOWN_CANCELLED { START_FAILED }`와 함께 대기실로 돌리고, 30분 넘게 진행 중인 방은 `ROOM_CLOSED { EXPIRED }`로 닫습니다. 예약이 유실돼도 사용자가 방에 갇히지 않게 하기 위해서입니다.
- `REACTION_SEND { roomId, reaction }`: 3초에 한 번(Valkey `react:rl:{roomId}:{userId}`), 보낸 사람을 뺀 방 사람들에게 `REACTION_RECEIVED`를 보냅니다.
- 상태를 바꾸는 메시지는 방 행을 잠근 트랜잭션에서 처리하고, 알림은 커밋한 뒤에 보냅니다. 에러 코드는 `ROOM_NOT_MEMBER`, `ROOM_NOT_HOST`, `ROOM_NOT_ENOUGH_PARTICIPANTS`, `ROOM_KICK_TARGET_INVALID`, `ROOM_ALREADY_STARTED`, `ROOM_NOT_FOUND`입니다.

### 문항 진행 (WebSocket)

- 시작: 카운트다운이 끝나 진행 중으로 바꾸는 트랜잭션에서 `battles`·`battle_questions`에 문항과 보기를 만들어 고정합니다.
  - 오답 보기를 만들 수 있는 단어만 섞어 내고, 단어가 문항 수보다 적으면 한 바퀴씩 다시 섞어 중복 출제합니다(바퀴가 바뀔 때 같은 단어가 연달아 나오지 않게).
  - 단어가 지워져 보기를 만들 수 없으면 `COUNTDOWN_CANCELLED { QUESTIONS_UNAVAILABLE }`로 대기실로 돌아갑니다.
- `QUESTION_STARTED { questionIndex, total, prompt, choices, deadlineAt }` → `ANSWER_SUBMIT { questionIndex, choiceIndex }` → 낸 사람에게만 `ANSWER_ACCEPTED { questionIndex }`.
- 판정은 서버가 받은 시각 기준이고, `deadlineAt`이 지나면 받지 않습니다. 에러 코드: `ANSWER_CLOSED`(마감·다른 문항), `ANSWER_ALREADY_SUBMITTED`, `BATTLE_NOT_IN_PROGRESS`(진행 중인 대결의 참가자가 아님, 교사 진행자 포함).
- 점수: 정답 100 + 남은 시간 비례 보너스 `round(50 × 남은 시간 / 제한 시간)`, 오답·미응답 0.
- 문항 종료: 마감 시각(BullMQ 지연 작업) 또는 남은 참가자가 모두 답했을 때. 답하지 않은 참가자는 `battle_answers`에 `choice_index` NULL로 남깁니다.
  - 사람마다 `QUESTION_ENDED { questionIndex, answerIndex, myResult, ranking }`을 보냅니다. `myResult`는 `{ choiceIndex, correct, score, totalScore, rank }`, 진행자(교사)는 `null`입니다.
  - `ranking`은 남아 있는 참가자의 `[{ userId, rank, score }]`이고, 누적 점수 높은 순, 같으면 총 풀이 시간이 짧은 순입니다(미응답 문항은 제한 시간 전체로 셉니다). 둘 다 같으면 같은 순위입니다.
  - 2초 뒤 다음 문항, 마지막 문항 다음에는 방을 `FINISHED`로 바꾸고 `BATTLE_FINISHED { battleId }`를 보냅니다. 방의 `battleId`는 대결이 시작되면 채워집니다.
- 한 번만 진행: 문항 시작·종료는 방 행 → 대결 행 순서로 잠근 트랜잭션에서 하고, 현재 문항·단계와 맞지 않는 작업은 아무것도 하지 않습니다. 서버가 여러 대이거나 작업이 다시 돌아도 문항이 두 번 시작·종료되지 않습니다. 답은 대결 행을 공유 잠금으로 읽어 문항 종료와 순서를 지킵니다.
  - 트랜잭션의 첫 문장을 잠금 읽기로 해서, 잠금을 기다리는 사이 들어온 답·나가기도 참가자·답 조회에 보이게 합니다(REPEATABLE READ 스냅숏).
  - 마감 작업이 서버 시계 차이로 일찍 돌면 끝내지 않고 마감 시각에 다시 예약합니다. 실패한 작업은 지워서 같은 id로 다시 예약할 수 있게 합니다.
- 끊김: 진행 중 연결이 모두 끊기면 `DISCONNECTED`로 표시하고 30초 뒤 유예 작업이 `LEFT`로 내보냅니다(남은 문항은 미응답). 그사이 돌아왔다 다시 끊겼으면 끊긴 시각(`disconnected_at`)이 달라 옛 유예는 무시합니다. 대기실에서 이미 끊겨 있던 참가자는 시작 시각부터 셉니다. 다시 접속해 `ROOM_RESUME` 없이 답해도 돌아온 것으로 봅니다(`CONNECTED`).
- `ROOM_RESUME { roomId }`: `ROOM_SUBSCRIBE`와 같고, 진행 중이면 지금 문항의 `QUESTION_STARTED`(이미 답했으면 `ANSWER_ACCEPTED`도) 또는 결과 표시 중이면 내 `QUESTION_ENDED`를 다시 보냅니다. 대결이 끝난 뒤면 `ROOM_STATE`와 `BATTLE_FINISHED { battleId }`를 보냅니다.
- 진행 중 나가거나 유예가 지나면 남은 사람이 모두 답했는지 다시 보고 바로 다음으로 넘어갑니다. 학생이 모두 나가면 교사용 방이라도 닫고 진행자에게 `ROOM_CLOSED { EMPTY }`를 보냅니다.

### 결과·XP·기록·다시 하기

- 확정: 마지막 문항 다음, 방을 `FINISHED`로 바꾸는 트랜잭션에서 `battle_results`에 참가자별 순위·점수·정답 수·총 풀이 시간·결과·XP를 남기고, 커밋한 뒤 랭킹에 반영하고 `BATTLE_FINISHED`를 보냅니다.
  - 참가자: 끝날 때 방에 남은 사람 + 시작한 뒤 나간 사람. 진행 중 나간 사람은 `LEFT`(순위 없음, 남은 문항은 0점·제한 시간 전체)로 남습니다.
  - 결과: 완주자끼리 점수, 같으면 총 풀이 시간 순. 1위 `WIN`, 1위가 여럿이면 `DRAW`, 나머지 `LOSE`. 둘 이상 시작했는데 혼자 완주하면 `WIN_BY_FORFEIT`.
- XP: 승 30, 무 15, 패 5 (`xp_ledger` 출처 `BATTLE`, `battle:{battleId}`). 하루 500 상한 포함.
  - 막는 경우: 중도 이탈과 한 문항도 답하지 않은 완주자 `NOT_COMPLETED`(순위·결과는 그대로), 부전승 `FORFEIT`, 같은 상대와 하루(KST) 4번째 완주부터 `REPEAT_LIMIT`, 상한 `DAILY_CAP`(일부만 받을 수도 있음).
  - 같은 상대 횟수는 `battle_daily_pairs`에 완주자 쌍마다 셉니다. 여럿이 한 대결은 처음 만나는(오늘 3번 미만인) 상대가 하나라도 있으면 줍니다.
- 오답노트: 틀렸거나 답하지 않은 단어를 (단어, 문제 유형)별로 출처 `BATTLE`로 쌓습니다. 같은 대결에 같은 단어가 여러 번 나와도 한 번만 셉니다.
- `GET /battles/{battleId}/result`: 순위(이탈자는 맨 아래)·내 XP(`todayTotal`은 조회 시점)·문항별 내 답. 참가자(이탈자 포함)와 교사용 방 진행자만(403), 끝나지 않았으면 404 `BATTLE_NOT_FOUND`. 진행자는 `me`·`correct`가 `null`입니다.
- `GET /battles/history` (학생): 최신순 커서, 요약 `{ total, winRate, avgAccuracy }`. 승률은 1위 횟수 / 완주한 대결 수, 평균 정답률은 완주한 대결만(둘 다 0~1, 완주한 대결이 없으면 `null`). 기록은 지우지 않습니다.
- `POST /battles/{battleId}/rematch`: 같은 설정으로 새 방(`source_battle_id`), 요청한 사람이 방장. 함께 한 대결이면 다른 사람의 내 단어팩도 그대로 씁니다(지워졌으면 404). 교사용 방은 진행한 교사만 교사용 반 방으로 만듭니다. 초대 알림은 알림 기능에서 붙입니다.

### 빠른 1:1 매칭

- `POST /battles/matchmaking` (학생, 202 `{ queuedAt, timeoutAt }`): WebSocket에 접속해 있어야 합니다(409 `MATCH_WS_NOT_CONNECTED`). 연결이 열린 직후에는 서버가 티켓을 확인하는 중이라 최대 2초까지 접속 등록을 기다린 뒤 판단합니다. 다른 방에 있으면 409 `ROOM_ALREADY_JOINED`, 이미 기다리는 중이면 409 `MATCH_ALREADY_QUEUED`.
- 대기열은 Valkey(`mm:queue` ZSET 점수 = 누적 XP, `mm:queued` 대기 시각)입니다. 들어오는 순간 기다리는 사람 가운데 누적 XP가 가장 가까운 상대(같으면 먼저 기다린 사람)와 짝짓고, 없으면 기다립니다. 차단 관계는 차단 기능이 생기면 제외합니다.
- 대기열에서 빼기와 성사를 Lua 스크립트 하나에서 처리해, 취소와 성사가 겹치면 먼저 도착한 쪽만 이깁니다.
- 성사: 요청에는 바로 202로 답하고, 방 만들기·시작은 응답 뒤에 이어서 처리합니다(동시에 많이 성사돼도 요청이 DB 연결을 기다리며 쌓이지 않게). 처리하는 동안 두 사람에게는 처리 중 표시(`PENDING:{시각}`)가 남아 다시 줄 서거나 취소해도 처리 중으로 보입니다. 처리에 실패하면 기다리던 상대와 요청한 사람을 원래 대기 시각으로 다시 줄 세웁니다(그사이 직접 다른 방에 들어간 사람은 빼고). 서버가 꺼질 때는 진행 중인 처리를 끝낸 뒤 연결을 닫습니다. 먼저 기다린 사람이 방장인 `QUICK_MATCH` 방(추천순 맨 앞 기본 단어팩, 한→영 4지선다, 10문항, 10초, 2명)을 만들고 두 사람에게 `MATCH_FOUND { roomId, inviteCode }`를 보낸 뒤 바로 카운트다운을 시작합니다. 기다리던 상대의 연결이 끊겼거나 그사이 다른 방에 들어갔으면 상대를 빼고 다음 대기자를 봅니다.
- 60초 동안 상대가 없으면 지연 작업이 빼고 `MATCH_TIMEOUT {}`을 보냅니다. 작업이 유실돼도 만료된 대기자는 짝지을 때 걸러집니다.
- `DELETE /battles/matchmaking` (204): 이미 성사됐으면 409 `MATCH_ALREADY_FOUND`(`detail = { roomId, inviteCode }`), 기다리는 매칭이 없으면 404 `MATCH_NOT_QUEUED`. 방을 만드는 중이면 결과가 나올 때까지 잠깐(최대 3초) 기다리고, 그래도 안 끝났으면 409 `MATCH_ALREADY_FOUND`(`detail` 없음, 곧 `MATCH_FOUND`가 감)로 답합니다. 30초 넘게 남은 처리 중 표시는 처리가 끊긴 것으로 보고 정리합니다. 남아 있는 성사 기록은 그 방에 아직 있을 때만 409로 답하고, 아니면 404입니다.
- 연결이 모두 끊기거나(다른 서버에 연결이 남아 있으면 그대로) 직접 방을 만들거나 들어가면 대기열에서 뺍니다. 성사 처리 중에 다시 요청하면 409 `MATCH_ALREADY_QUEUED`, 만료 작업이 유실돼 남은 자기 대기는 새로 줄 서면 덮습니다.

### 연습 모드

- `POST /practice/sessions` (학생, 201): 대결과 같은 방식(오답 보기를 만들 수 있는 단어만, 모자라면 중복 출제)으로 4지선다 문항을 만들어 정답과 함께 내려줍니다. 시간은 클라이언트가 재고 XP는 없습니다. 단어 10개 이상(400 `BATTLE_PACK_TOO_FEW_WORDS`).
- `POST /practice/sessions/{practiceId}/complete` (200 `{ score, correctCount, total }`): 대결과 같은 점수(정답 100 + 남은 시간 비례 보너스 최대 50). 제한 시간을 넘긴 답과 보내지 않은 문항은 미응답입니다.
  - 틀렸거나 답하지 않은 단어는 오답노트(출처 `BATTLE`)로 쌓습니다(같은 단어는 한 번). 대결 결과와 같은 `recordWrongWords`를 씁니다.
  - 세션 행을 잠그고 처리해 한 번만 끝낼 수 있습니다(409 `BATTLE_PRACTICE_ALREADY_COMPLETED`). 남의 연습·없는 연습은 404 `BATTLE_PRACTICE_NOT_FOUND`, 없는 문항 번호·같은 문항 두 번은 400.
- `practice_sessions`에 문항(단어 id 포함)을 남기고, 기록 화면이 없으므로 매일 정리에서 7일 지난 연습을 지웁니다.

### 오늘의 챌린지

- 하루(KST) 한 번, 모두 같은 문제·같은 순서입니다(`daily_challenges`, 날짜가 키). 기본 단어팩 5개를 무작위로 골라 그 팩들의 단어를 섞어 한→영 4지선다 10문항, 문항당 10초. 오답 보기는 그 단어의 팩에서 고릅니다.
  - `challenge` 큐의 job scheduler가 매일 23:50(KST)에 다음 날 문제를 미리 만들고, 없으면 그날 처음 조회할 때 만듭니다. 여러 서버가 동시에 만들어도 날짜가 키라 하나만 남고, 한 서버 안에서는 몰린 요청이 한 번만 만듭니다. 만들지 못하면 503 `CHALLENGE_UNAVAILABLE`, 1분 동안 다시 시도하지 않습니다.
- `GET /challenges/today` (학생): `{ date, questionCount, timeLimitSec, participated, myResult: { score, correctCount, xp } | null }`.
- `POST /challenges/today/attempt` (201): 정답 없이 문항만. 사용자당 하루 한 번(`challenge_attempts` UNIQUE(user_id, date)). 이미 끝냈으면 409 `CHALLENGE_ALREADY_DONE`, 시작만 했으면 409 `CHALLENGE_IN_PROGRESS`(`detail = { attemptId, questions }`, 시작 응답을 못 받았어도 이어서 풀 수 있게).
- `POST /challenges/today/attempt/{attemptId}/complete` (Idempotency-Key 필수, 없으면 400): `{ score, correctCount, total, results: [{ index, correct, answerIndex }], xp }`.
  - 점수는 연습과 같습니다. 문항별 제한 시간을 넘긴 답은 미응답이고, 시작 시각부터 `문항 수 × (제한 시간 + 1초) + 10초`가 지나 끝내면 모두 미응답이고 XP 막힌 이유는 `NOT_COMPLETED`입니다. 문항별 시간은 클라이언트가 보낸 값이라 서버는 전체 시간만 확인합니다.
  - XP는 정답 1개당 3(`xp_ledger` 출처 `CHALLENGE`, `challenge:{date}`), 하루 500 상한 포함. 시도 행을 잠그고 처리해 한 번만 끝낼 수 있습니다(409 `CHALLENGE_ALREADY_DONE`).
- `@Idempotent({ required: true })`: 멱등 키가 필수인 API는 키 없이 보내면 400을 돌려줍니다.
