# 부하 테스트

## 부하 테스트 (k6)

실시간 대결이 전교생 동시 대결을 버티는지 개발 서버에서 확인합니다. 시나리오는 `load/battle.js`입니다.

- `SCENARIO=match`: 사용자마다 티켓 → WebSocket 접속 → 빠른 매칭 → 문항마다 0.5~4초 생각한 뒤 아무 보기나 답 → `BATTLE_FINISHED` 뒤 결과 조회. `VUS`명이 `ITERATIONS`판씩 합니다.
- `SCENARIO=room`: `ROOM_SIZE`명씩 `ROOMS`개 방을 미리 만들고, 모두 들어오면 방장이 시작합니다(반 전체 대결). 다 모이지 않아도 1분 뒤 시작합니다.
- 요청이 실패하거나 카운트다운이 취소되면 기다리지 않고 원인(상태·에러 코드)을 `console.warn`으로 남기고 그 판을 끝냅니다.
- 기록하는 지표: `answer_ack_ms`(답 → `ANSWER_ACCEPTED`), `question_start_delay_ms`(서버가 문항을 시작한 시각 → 받은 시각, 작업 지연 포함, 부하 PC와 서버 시계가 맞아야 의미 있음), `match_wait_ms`, `battles_finished`, `match_timeouts`, `server_errors`(코드별), 요청 종류별 응답 시간 `req_ticket_ms`·`req_matchmaking_ms`·`req_join_ms`·`req_result_ms`.

### 목표

| 시나리오 | 설정                   | 동시 접속 | 통과 기준                                                                                     |
| -------- | ---------------------- | --------- | --------------------------------------------------------------------------------------------- |
| match    | `VUS=200 ITERATIONS=3` | 200명     | `answer_ack_ms` p95 < 300ms, `question_start_delay_ms` p95 < 500ms, 에러 < 10, HTTP 실패 < 1% |
| room     | `ROOM_SIZE=30 ROOMS=6` | 180명     | 위와 같음                                                                                     |

전교생(3학년 × 4반, 약 200명)이 한꺼번에 대결하는 경우를 기준으로 잡았습니다. 서버는 CPU 70% 미만, 앱 컨테이너 메모리(개발 서버 `mem_limit` 768MB)에 여유가 있어야 합니다. 한 판도 끝나지 않거나 검사(check) 실패가 1%를 넘으면 실패로 봅니다.

### 실행

0. 빠른 매칭·반 대결은 단어 10개 이상인 기본 단어팩이 있어야 합니다. 없으면 매칭이 503 `MATCH_UNAVAILABLE`로 실패합니다. 먼저 `기본 단어팩 시드`로 넣어 둡니다.
1. 개발 서버에서 계정과 토큰을 만듭니다(토큰은 30분 유효, 파일은 소유자만 읽을 수 있고 화면에 출력하지 않습니다).

   ```bash
   docker exec <앱 컨테이너> /nodejs/bin/node dist/load-users.js create 200 /tmp/tokens.json --confirm-dev
   docker cp <앱 컨테이너>:/tmp/tokens.json ./tokens.json
   ```
2. 서버와 다른 PC(같은 학교 네트워크)에서 k6를 돌립니다. 같은 서버에서 돌리면 k6가 CPU를 나눠 써서 결과가 흐려집니다.

   ```bash
   k6 run -e BASE_URL=https://<개발 서버> -e TOKENS=$PWD/tokens.json -e SCENARIO=match -e VUS=200 load/battle.js
   k6 run -e BASE_URL=https://<개발 서버> -e TOKENS=$PWD/tokens.json -e SCENARIO=room -e ROOMS=6 load/battle.js
   ```

   `WS_URL`로 WebSocket 주소를, `CLIENT_VERSION`으로 앱 버전 헤더를 바꿀 수 있습니다(기본 `99.0.0`). 토큰 파일은 절대 경로로 넘깁니다(상대 경로는 `load/` 기준). 토큰이 만료되면 `tokens` 명령으로 다시 발급합니다. 실행 사이에는 정리(4번)를 해야 지난 방에 묶이지 않습니다.
3. 도는 동안 서버 지표를 남깁니다: `docker stats`(CPU·메모리), `valkey-cli info stats`·`info memory`, MySQL `SHOW GLOBAL STATUS LIKE 'Threads_running'`·느린 쿼리 로그, 앱 로그의 에러.
4. 끝나면 계정과 대결·XP·랭킹 기록을 지웁니다.

   ```bash
   docker exec <앱 컨테이너> /nodejs/bin/node dist/load-users.js cleanup --confirm-dev
   rm tokens.json
   ```

- 계정은 `datagsm_id`가 `loadtest:`로 시작하는 학생이고, 학년·반을 돌려 가며 나누며 랭킹 목록에는 나오지 않습니다. 명령은 개발 서버 compose에만 있는 `LOAD_TEST_ALLOWED=true`와 `--confirm-dev`가 둘 다 있어야 돕니다(상용 서버에서 잘못 실행해도 아무것도 하지 않음). 앱 이미지는 distroless라 `node` 대신 `/nodejs/bin/node`로 실행합니다.
- 빠른 매칭은 같은 대기열을 쓰므로, 테스트 중 개발 서버의 실제 사용자가 매칭하면 부하 계정과 짝지어질 수 있습니다.
