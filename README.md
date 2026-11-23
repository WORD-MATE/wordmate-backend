# WordMate Backend

## 기술 스택

- **런타임·프레임워크**: Node.js, NestJS + Fastify, TypeScript
- **검증·API 문서**: Zod, OpenAPI 3.1, Swagger UI
- **DB**: MySQL 8.4, Drizzle ORM
- **인메모리·큐**: Valkey, BullMQ
- **실시간**: WebSocket
- **테스트**: Vitest, Testcontainers

## 시작하기

### 요구 사항

- Node.js 26 이상
- pnpm 10 (`npm i -g pnpm@10`)
- Docker

### 실행

```bash
pnpm install
docker compose up -d
pnpm db:migrate
pnpm dev
```

실행 전에 프로젝트 루트의 `.env`(또는 `.env.local`)에 아래 [환경 변수](#환경-변수)의 필수 값을 채웁니다. `JWT_PRIVATE_KEY`는 `pnpm jwt:keygen`으로 만듭니다.

`http://localhost:3000/health`가 `{"status":"ok",...}`를 돌려주면 정상입니다. DB나 Valkey에 연결되지 않으면 503을 돌려줍니다.

### API 문서

- Swagger UI: http://localhost:3000/swagger-ui/index.html
- OpenAPI 3.1 JSON: http://localhost:3000/v3/api-docs (클라이언트 코드 생성에 사용)

`NODE_ENV=production`에서는 열리지 않습니다.

## 명령어

| 명령                          | 설명                                                         |
| ----------------------------- | ------------------------------------------------------------ |
| `pnpm dev`                    | 개발 서버 (변경 감지)                                        |
| `pnpm build`                  | 빌드 (`dist/`)                                               |
| `pnpm start`                  | 빌드 결과 실행                                               |
| `pnpm test`                   | 단위 테스트                                                  |
| `pnpm test:e2e`               | 통합 테스트 (Docker 필요, MySQL·Valkey 컨테이너 자동 실행)   |
| `pnpm typecheck`              | 타입 검사                                                    |
| `pnpm lint`                   | 린트·포맷 검사                                               |
| `pnpm format`                 | 린트·포맷 자동 수정                                          |
| `pnpm db:generate`            | 스키마 변경으로 마이그레이션 생성 (`drizzle/`)               |
| `pnpm db:migrate`             | 마이그레이션 적용                                            |
| `pnpm db:seed <파일>`         | 기본 단어팩 시드 반영 (아래 "기본 단어팩 시드" 참고)         |
| `pnpm db:seed-morning <파일>` | 오늘의 문장 시드 반영 (아래 "오늘의 문장" 참고)              |
| `pnpm ranking:rebuild`        | XP 원장에서 이번 주·이번 달·전체 랭킹 재구성 (Valkey 복구용) |
| `pnpm db:studio`              | Drizzle Studio (DB 브라우저)                                 |
| `pnpm jwt:keygen`             | JWT 서명용 Ed25519 키 생성                                   |

## 프로젝트 구조

```
src/
  common/    에러, 권한, Zod 검증·문서화, enum, 페이지네이션, KST 시간
  config/    환경 변수 검증
  infra/     DB, Valkey, 큐
  modules/   도메인별 모듈
test/        통합 테스트
drizzle/     마이그레이션
```

## API 공통 규칙

- **필수 헤더**: `X-Client-Platform` (`IOS` | `ANDROID` | `WEB`), `X-Client-Version` (예: `1.2.0`)
- **에러 응답**: `{ "code": String, "message": String, "detail": Object | null, "traceId": String }`
- **ID**: UUIDv7 문자열 / **시간**: ISO-8601 UTC / **날짜**: KST `YYYY-MM-DD`
- **목록**: 커서 페이지네이션 `?cursor=&size=` (기본 20, 최대 50) → `{ items, nextCursor }`
- **권한**: 엔드포인트마다 `@Auth('ALL' | 'USER' | 'STUDENT' | 'TEACHER' | 'ADMIN')`, 생략하면 `USER`
- **재전송**: `@Idempotent()`가 붙은 API는 `Idempotency-Key`(UUID)를 같게 보내면 처음 응답을 돌려줌
- **요청 제한**: 로그인 사용자는 사용자별 1분 120회, 비로그인은 IP별 1분 600회(로그인 API는 120회). `@Throttle`로 조정, 초과 시 429 + `Retry-After`
  - 학생들이 학교 공인 IP를 함께 쓰고 학교 프록시도 실제 IP를 넘기지 않아서, 비로그인 IP 제한은 사실상 서버 전체 상한입니다.

### 데코레이터

| 데코레이터                                        | 용도                                |
| ------------------------------------------------- | ----------------------------------- |
| `@Auth(...)`                                      | 접근 권한                           |
| `@ZodBody` `@ZodQuery` `@ZodParam` `@ZodResponse` | 요청 검증·응답 정리·Swagger 문서    |
| `@Idempotent()`                                   | Idempotency-Key 재전송 처리         |
| `@AllowDuringMaintenance()`                       | 점검 중에도 허용                    |
| `@SkipClientCheck()`                              | 헤더·버전·점검 검사 생략 (인프라용) |
| `@Throttle()` `@SkipThrottle()`                   | 요청 제한 조정                      |
| `@SkipTermsCheck()`                               | 약관 동의·담당 반 선택 전에도 허용  |
| `@SkipTeacherClassCheck()`                        | 교사 담당 반 선택 전에도 허용       |

### 엔드포인트 작성 예시

```ts
const CreatePack = z.object({ name: z.string().min(1).max(30) });
const Pack = z.object({ packId: z.string(), name: z.string() }).meta({ id: 'Pack' });

@Auth('STUDENT')
@Post('packs')
@ZodResponse(Pack, { status: 201 })
create(@ZodBody(CreatePack) body: z.infer<typeof CreatePack>) { ... }
```

`ZodBody` / `ZodQuery` / `ZodParam`은 요청 검증과 Swagger 문서를, `ZodResponse`는 응답 문서화와 스키마 밖 필드 제거를 함께 처리합니다.

## 환경 변수

| 이름                    | 기본값                                   | 설명                                                                |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| `NODE_ENV`              | `development`                            | `development` / `test` / `production`                               |
| `HOST`                  | `0.0.0.0`                                | 서버 바인딩 주소                                                    |
| `PORT`                  | `3000`                                   | 서버 포트                                                           |
| `LOG_LEVEL`             | `info`                                   | `fatal` / `error` / `warn` / `info` / `debug` / `trace` / `silent`  |
| `CORS_ORIGINS`          | (없음)                                   | 허용할 웹 Origin, 쉼표로 구분                                       |
| `DATABASE_URL`          | (필수)                                   | `mysql://user:pass@host:3306/db`                                    |
| `DB_POOL_SIZE`          | `20`                                     | DB 연결 수 (MySQL `max_connections`보다 작게)                       |
| `VALKEY_URL`            | (필수)                                   | `redis://host:6379`                                                 |
| `JWT_PRIVATE_KEY`       | (필수)                                   | Ed25519 개인키 PEM (`pnpm jwt:keygen`으로 생성)                     |
| `JWT_KEY_ID`            | `k1`                                     | 토큰 헤더의 kid (키 교체 시 변경)                                   |
| `DATAGSM_CLIENT_ID`     | (필수)                                   | DataGSM OAuth 클라이언트 ID                                         |
| `DATAGSM_REDIRECT_URIS` | (필수)                                   | 허용할 redirectUri, 쉼표로 구분 (DataGSM에 등록한 값과 같아야 함)   |
| `DATAGSM_AUTH_URL`      | `https://oauth.authorization.datagsm.kr` | DataGSM 인증 서버                                                   |
| `DATAGSM_RESOURCE_URL`  | `https://oauth.resource.datagsm.kr`      | DataGSM 사용자 정보 서버                                            |
| `DATAGSM_OPENAPI_URL`   | `https://openapi.datagsm.kr`             | DataGSM OpenAPI 서버 (학적 동기화)                                  |
| `DATAGSM_API_KEY`       | (없음)                                   | DataGSM OpenAPI 키 (`student:read`). 없으면 학적 동기화를 건너뜀    |
| `TRUST_PROXY`           | (없음)                                   | 신뢰할 리버스 프록시 IP·CIDR, 쉼표로 구분 (실제 클라이언트 IP 판별) |
| `METRICS_PORT`          | `9464`                                   | `/metrics` 전용 내부 포트 (서버에 열지 않음). `0`이면 끔            |
| `SWAGGER_ENABLED`       | `production`이 아니면 켜짐               | `true` / `false`로 Swagger 문서 강제 설정                           |
| `SHARE_LINK_BASE`       | `wordmate://`                            | 공유 링크 앞부분. 웹 도메인이 생기면 `https://도메인`으로 바꿈      |
| `APNS_KEY_P8`           | (없음)                                   | APNs 인증 키(.p8) PEM. 한 줄로 넣을 때는 줄바꿈을 `\n`으로          |
| `APNS_KEY_ID`           | (없음)                                   | APNs 키 ID                                                          |
| `APNS_TEAM_ID`          | (없음)                                   | Apple 팀 ID                                                         |
| `APNS_BUNDLE_ID`        | (없음)                                   | iOS 앱 번들 ID (apns-topic)                                         |
| `APNS_SANDBOX`          | `false`                                  | `true`면 APNs 개발 서버로 보냄                                      |
| `FCM_PROJECT_ID`        | (없음)                                   | Firebase 프로젝트 ID                                                |
| `FCM_CLIENT_EMAIL`      | (없음)                                   | FCM 서비스 계정 이메일                                              |
| `FCM_PRIVATE_KEY`       | (없음)                                   | FCM 서비스 계정 비공개 키 PEM                                       |
| `VAPID_PUBLIC_KEY`      | (없음)                                   | Web Push VAPID 공개 키                                              |
| `VAPID_PRIVATE_KEY`     | (없음)                                   | Web Push VAPID 비공개 키                                            |
| `VAPID_SUBJECT`         | (없음)                                   | VAPID 연락처 (`mailto:` 또는 URL)                                   |
| `UPLOAD_DIR`            | `./uploads`                              | 1:1 문의 이미지를 둘 폴더                                           |
| `UPLOAD_SIGNING_SECRET` | `JWT_PRIVATE_KEY`에서 유도               | 이미지 주소 서명 키 (32자 이상). 바꾸면 내준 주소가 바로 무효       |

값이 없거나 형식이 틀리면 서버가 시작되지 않습니다.

## 점검 모드·강제 업데이트

Valkey의 `app:config` 키(JSON)로 설정하며 서버는 5초마다 다시 읽습니다. 관리자 API가 생기기 전까지는 직접 설정합니다.

```bash
valkey-cli SET app:config '{"maintenance":{"enabled":true,"message":"정기 점검","endsAt":"2026-12-01T00:00:00.000Z"},"minVersion":{"IOS":"1.2.0"},"latestVersion":{"IOS":"1.5.0"},"storeUrl":{"IOS":"https://apps.apple.com/..."}}'
```

- 점검 중: 503 `MAINTENANCE` (`detail`: `message`, `endsAt`)
- 최소 버전 미만: 426 `UPDATE_REQUIRED` (`detail.storeUrl`, 웹은 `null`)
- `GET /app/status`는 점검 중에도 200으로 점검 정보와 업데이트 상태(`REQUIRED` / `RECOMMENDED` / `NONE`)를 돌려줍니다.

## 상태 확인·지표

상태 확인은 인증·클라이언트 헤더가 필요 없고 점검 중·강제 업데이트 중에도 응답합니다. 10초마다 오는 요청이라 접속 로그와 요청 지표에서는 뺍니다(오류는 로그에 남음).

| 엔드포인트          | 확인 내용                    | 실패                                                       | 용도                           |
| ------------------- | ---------------------------- | ---------------------------------------------------------- | ------------------------------ |
| `GET /health`       | DB·Valkey 연결 (각 2초 제한) | 503 `HEALTH_CHECK_FAILED`                                  | 컨테이너 healthcheck·배포 확인 |
| `GET /health/live`  | 프로세스가 응답하는지만      | 없음                                                       | 의존 서비스와 무관한 생존 확인 |
| `GET /health/ready` | DB·Valkey 연결과 응답 시간   | 503 `HEALTH_CHECK_FAILED`, 종료 중이면 503 `SHUTTING_DOWN` | 요청을 받을 준비가 됐는지      |

`/health`는 기존 응답(`{"status":"ok","checks":{"db":"up","valkey":"up"}}`)을 그대로 유지합니다. compose의 `restart: unless-stopped`는 unhealthy만으로 컨테이너를 다시 시작하지 않으므로 Valkey가 잠깐 느려도 재시작되지 않습니다.

### 지표 (Prometheus)

`GET /metrics`는 API 포트(3000)가 아니라 내부 포트 `METRICS_PORT`(기본 `9464`)에서만 응답합니다. compose에서 이 포트를 서버에 열지 않으므로 학교 프록시를 거친 외부 요청은 닿지 않고, 같은 도커 네트워크(`wordmate_internal`)의 Prometheus만 `app:9464/metrics`로 수집합니다. `METRICS_PORT=0`이면 끕니다.

| 지표                            | 라벨                        | 설명                                                |
| ------------------------------- | --------------------------- | --------------------------------------------------- |
| `http_requests_total`           | `method`, `route`, `status` | 요청 수. 오류율은 `status`로 계산                   |
| `http_request_duration_seconds` | `method`, `route`, `status` | 처리 시간 히스토그램 (10ms~10s)                     |
| `wordmate_realtime_connections` | 없음                        | 이 인스턴스에 인증을 마친 WebSocket 연결 수         |
| `wordmate_queue_jobs`           | `queue`, `state`            | 큐별 `waiting` / `active` / `delayed` / `failed` 수 |
| `wordmate_queue_up`             | `queue`                     | 큐 작업 수를 1초 안에 읽었으면 1, 아니면 0          |
| `process_*`, `nodejs_*`         | 없음                        | 메모리·CPU·이벤트 루프 지연·GC 등 기본 지표         |

- `route`는 실제 주소가 아니라 라우트 패턴(`/packs/:packId`)이라 라벨 수가 늘지 않습니다. 맞는 라우트가 없는 요청은 `UNMATCHED` 하나로 묶습니다.
- 큐 작업 수는 수집할 때 Valkey에서 읽습니다. Valkey가 느리면 그 큐만 `wordmate_queue_up 0`이 되고 나머지 지표는 그대로 나옵니다.

## Docker

```bash
docker build -t wordmate-backend .
docker run -p 3000:3000 -e DATABASE_URL=... -e VALKEY_URL=... wordmate-backend
```

## 배포 (개발 서버)

`develop`에 머지되면 GitHub Actions(`deploy-dev.yml`)가 이미지를 GHCR(`ghcr.io/word-mate/wordmate-backend`)에 올리고, 서버에 SSH로 접속해 `deploy/dev/compose.yml`로 교체합니다.

- 구성: 학교 플랫폼 도메인(`wordmate-dev.https.gsmsv.site`, HTTPS 처리) → 서버 3000 포트(앱) ← MySQL 8.4 · Valkey 9, 모두 컨테이너
- 앱이 뜨기 전에 `migrate` 컨테이너가 마이그레이션을 실행합니다.
- 서버 파일: `~/wordmate/` (`compose.yml`은 배포 때마다 덮어씀, `.env`만 서버에서 관리)

### 서버 최초 설정

1. 학교 서버 관리 페이지에서 도메인을 추가합니다 (서브도메인 `wordmate-dev`, 내부 포트 `3000`).
2. 서버에서 `deploy/setup-server.sh`를 실행합니다 (Docker 설치, swap 2GB, `~/wordmate` 생성). 끝나면 다시 로그인합니다.
3. `~/wordmate/.env`를 만듭니다.

```bash
MYSQL_PASSWORD=          # openssl rand -hex 24
MYSQL_ROOT_PASSWORD=     # openssl rand -hex 24
JWT_PRIVATE_KEY=         # openssl genpkey -algorithm ed25519 | awk '{printf "%s\\n", $0}'
DATAGSM_CLIENT_ID=
DATAGSM_REDIRECT_URIS=
CORS_ORIGINS=
SWAGGER_ENABLED=true
DATAGSM_API_KEY=         # 학적 동기화 (없으면 건너뜀)
# TRUST_PROXY=10.0.0.117 # 학교 프록시 주소가 다르면 지정
```

4. 배포용 SSH 키를 만들어 공개키를 서버의 `~/.ssh/authorized_keys`에 추가합니다.
5. GitHub 저장소 Settings에 등록합니다. 시크릿은 Environments → `development`, 변수는 Secrets and variables → Actions → Variables(저장소 변수)에 넣습니다. `DEV_DOMAIN`이 없으면 배포 단계를 건너뜁니다.

| 종류     | 이름                  | 값                                       |
| -------- | --------------------- | ---------------------------------------- |
| Secret   | `DEV_SSH_HOST`        | 서버 주소                                |
| Secret   | `DEV_SSH_USER`        | `ubuntu`                                 |
| Secret   | `DEV_SSH_PORT`        | SSH 포트 (22면 생략)                     |
| Secret   | `DEV_SSH_KEY`         | 배포용 개인키                            |
| Secret   | `DEV_SSH_KNOWN_HOSTS` | `ssh-keyscan -p {포트} {서버 주소}` 결과 |
| Variable | `DEV_DOMAIN`          | `wordmate-dev.https.gsmsv.site`          |

### 운영 명령

```bash
cd ~/wordmate
docker compose ps
docker compose logs -f app
docker compose exec valkey valkey-cli         # 점검 모드 설정 등
docker compose exec mysql mysql -uroot -p wordmate
docker compose up -d --force-recreate app     # .env 수정 후 적용
```

배포 때 받은 이미지에 `develop` 태그도 붙여 두므로, 서버에서 직접 `docker compose`를 실행해도 마지막 배포 이미지를 씁니다 (GHCR 로그인 불필요).

### 개발 서버 이전

새 서버로 옮길 때는 최초 설정 1~4를 새 서버에서 다시 하고, GitHub의 `DEV_SSH_*` 시크릿과 `DEV_DOMAIN`을 새 서버 값으로 바꿉니다. 바꾸기 전까지는 develop 머지가 옛 서버로 배포됩니다.

개발 데이터를 옮기려면 옛 서버에서 덤프해 새 서버에서 넣습니다. 새 서버에서는 앱을 띄우기 전에 MySQL만 먼저 올립니다.

```bash
# 옛 서버
cd ~/wordmate && docker compose exec -T mysql sh -c 'mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines wordmate' | gzip > wordmate.sql.gz
# 새 서버 (wordmate.sql.gz를 복사한 뒤)
cd ~/wordmate && docker compose up -d mysql
gunzip -c wordmate.sql.gz | docker compose exec -T mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" wordmate'
```

`JWT_PRIVATE_KEY`를 새로 만들면 기존 로그인은 모두 풀리고 문의 이미지 서명 주소도 바뀝니다. 그대로 쓰려면 옛 서버의 값을 옮깁니다.

## 배포 (상용 서버)

`deploy/prod/compose.yml`로 개발 서버와 같은 구성(앱·마이그레이션·MySQL·Valkey)을 띄웁니다. 기본 이미지 태그는 `main`입니다.

- 서버 사양: 2 Core / 8 GB / 40 GB. 메모리 제한은 앱 1.5 GB, MySQL 2.5 GB(buffer pool 1.5 GB), Valkey 640 MB이고, 나머지는 모니터링과 OS 몫입니다.
- 앱 포트(3000)만 서버에 열고 MySQL·Valkey는 컨테이너 네트워크 안에서만 씁니다.
- 부하 테스트 계정 스크립트는 상용에서 막혀 있습니다(`LOAD_TEST_ALLOWED` 없음).
- 데이터는 named volume `mysql-data`, `valkey-data`, `uploads`(문의 이미지)에 있습니다.

### 상용 서버 최초 설정

1. 학교 서버 관리 페이지에서 도메인을 추가합니다 (내부 포트 `3000`).
2. 저장소의 `deploy/setup-server.sh`를 서버로 복사해 `SWAP_SIZE=4G bash setup-server.sh`로 실행하고 다시 로그인합니다.
3. `~/wordmate/.env`를 만듭니다. 항목은 개발 서버와 같고, 비밀번호·JWT 키는 개발 서버와 다른 값으로 새로 만듭니다. `SWAGGER_ENABLED`는 넣지 않습니다(상용에서는 API 문서를 열지 않음). `CORS_ORIGINS`·`DATAGSM_REDIRECT_URIS`는 상용 웹 주소로 넣습니다.
4. 배포용 SSH 키를 개발 서버와 따로 만들어 공개키를 `~/.ssh/authorized_keys`에 추가합니다.
5. 앱 실행(`compose.yml` 복사, `main` 이미지 받기·교체)은 main 배포 워크플로가 합니다. `main` 이미지는 이 워크플로가 처음 돌 때 만들어지므로, 그 전에 서버에서 직접 `docker compose up`을 하면 이미지를 받지 못합니다.
6. 첫 배포 뒤 관리자가 될 사람이 한 번 로그인하면, DB에서 그 계정을 찾아 최초 관리자로 지정합니다. 이메일이 비어 있는 계정도 있어서 ID로 지정하고, 바뀐 행이 1개인지 확인합니다. 지정한 사람은 다시 로그인해야 관리자 권한이 토큰에 들어갑니다.

```bash
docker compose exec mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" wordmate'
# mysql> SELECT BIN_TO_UUID(id), name, email, student_number, role FROM users WHERE name = '이름';
# mysql> UPDATE users SET is_admin = 1 WHERE id = UUID_TO_BIN('위에서 찾은 ID');   -- Rows matched: 1 확인
```

운영 명령은 개발 서버와 같습니다(`docker compose`는 `~/wordmate`에서 실행).

## 인증

1. 클라이언트가 PKCE로 DataGSM 로그인 → 인가 코드 수신
2. `POST /auth/datagsm { code, codeVerifier, redirectUri }` → 액세스 토큰(30분)·리프레시 토큰(30일)·`nextStep`·`user`
3. API 호출: 앱은 `Authorization: Bearer {accessToken}`, 웹은 쿠키(`__Host-at`) 자동 전송
4. `AUTH_TOKEN_EXPIRED`(401)이면 `POST /auth/refresh` 1회 후 재시도. 리프레시 토큰은 매번 새로 바뀜
5. `POST /auth/logout`: 리프레시 토큰만 있으면 됨 (앱은 본문 `refreshToken`, 웹은 쿠키)

웹은 토큰을 응답 본문 대신 HttpOnly 쿠키로 받습니다.

- DataGSM 인가 요청의 scope: `datagsm:account_read datagsm:student_read` (없으면 사용자 정보 조회 403 또는 학년·반 누락)
- 클라이언트 없이 로그인 확인: `pnpm datagsm:login` (기본 대상은 개발 서버, 다른 서버는 `pnpm datagsm:login http://localhost:3000`). 브라우저로 DataGSM 로그인 → `POST /auth/datagsm` → `GET /users/me` → 로그아웃까지 실행합니다. 서버의 `DATAGSM_REDIRECT_URIS`에 `http://localhost:8765/callback`이 있어야 합니다.

### 기기

로그인 1회 = 기기 1개(세션)입니다. 액세스 토큰의 `sid`가 기기 ID입니다.

- `POST /devices`: 로그인 직후, 푸시 권한 허용 직후, 푸시 토큰이 바뀔 때 기기 이름과 푸시 정보를 등록. 푸시를 끄면 `pushType: null`
- 플랫폼별 푸시: iOS는 APNS·FCM, Android는 FCM, 웹은 WEBPUSH만 허용
- 같은 푸시 토큰이 다른 기기에 등록돼 있으면 그쪽 등록은 해제됩니다 (공용 기기 대비)
- `DELETE /devices/{deviceId}`: 다른 기기 원격 로그아웃. 그 기기는 액세스 토큰이 만료되는 최대 30분 뒤 로그아웃됨. 현재 기기는 `POST /auth/logout` 사용
- 로그아웃·원격 로그아웃·리프레시 토큰 재사용 감지 시 푸시 등록도 함께 해제됩니다

### 프로필

- `PATCH /users/me/profile { avatarId?, representativeBadgeId? }` → `Me`. 생략한 항목은 그대로 두고, `null`이면 해제합니다(아바타는 `default`로 돌아감). 이름·학번·학년·반은 DataGSM 값이라 바꿀 수 없습니다.
- 목록에 없는 아바타는 400 `USER_AVATAR_NOT_FOUND`, 가지고 있지 않거나 내려간(`active=false`) 배지는 400 `USER_BADGE_NOT_OWNED`입니다. 교사는 아바타만 바꿀 수 있습니다(배지가 없어 대표 배지는 항상 `USER_BADGE_NOT_OWNED`).
- 대표 배지는 `users.representative_badge_id`에 저장합니다. 배지 정의가 지워지면 FK로 비워집니다.
- `GET /users/avatars`: 기본 아바타 목록 `[{ avatarId, imageUrl }]`. 별도 테이블 없이 코드의 `AVATAR_IDS`(src/modules/users/avatars.ts)가 목록이고 지금 값은 임시입니다. `imageUrl`은 배지처럼 앱이 이미지 주소로 바꾸는 키(`avatars/{avatarId}`)입니다. 목록에서 ID를 빼려면 그 ID를 저장한 사용자도 `default`로 바꿔야 합니다.

### 회원 탈퇴

`DELETE /users/me { confirm: true }` → 204. `confirm`이 없거나 false면 400 `USER_WITHDRAW_NOT_CONFIRMED`. 약관 동의·담당 반 선택 전에도 호출할 수 있습니다.

- 유예 기간 없이 바로 파기합니다. 사용자 행은 끝난 대결 결과처럼 다른 사람의 기록이 참조해서 지우지 않고 비웁니다: 상태 `WITHDRAWN`, 이름은 "탈퇴한 사용자", 이메일·학번·학년·반·번호·DataGSM 식별값(계정 ID·학생 ID)·마지막 로그인·정지 정보는 NULL, 관리자 권한·XP·랭킹 공개는 해제, 아바타·대표 배지는 기본값으로. DataGSM 토큰은 원래 저장하지 않습니다.
- 모든 기기(세션·리프레시 토큰·푸시 등록)를 지우고, 남은 액세스 토큰은 Valkey 차단으로 바로 401 `AUTH_INVALID`가 됩니다. 이미 열린 WebSocket은 다음 메시지에서 끊깁니다.
- 지우는 것: 학습 세션·기록·오답노트·암기 진행·일별 통계·연속 학습·즐겨찾기·연습·챌린지 기록·오늘의 문장 완료, XP 원장·배지·미션·지난 시즌 순위·부정 의심 표시, 친구·친구 요청·차단(양쪽 방향), 알림·알림 설정·공지 읽음·약관 동의 이력, 문의(첨부 이미지 파일 포함), 교사의 담당 반 연결.
- 내 단어팩은 단어와 함께 지웁니다. 대결방에 쓰인 팩은 다른 사람의 대결 문항이 단어를 참조하므로 소프트 삭제하고 공유를 끊습니다. 다른 사람이 복사한 팩은 따로 있는 사본이라 그대로 남습니다.
- 남기는 것: 끝난 대결의 결과·답안(다른 참가자에게 "탈퇴한 사용자"로 보임), 내가 하거나 받은 신고, 제재 이력, 관리자로 남긴 감사 로그·처리 기록(이름만 "탈퇴한 사용자"로 보임).
- 이번 기간과 아직 마감 전일 수 있는 지난 기간의 주간·월간·전체 랭킹에서 바로 빠지고 랭킹 목록 캐시도 지웁니다.
- 들어가 있던 대결방에서는 나가기와 같은 규칙으로 자동 퇴장합니다(진행 중이면 남은 문항 0점, 방장이면 다음 참가자에게 넘김). 교사가 진행하던 교사용 방은 닫히고, 빠른 매칭 대기열에서도 빠집니다.
- 활동 중인 마지막 관리자는 409 `USER_LAST_ADMIN`입니다. 다른 관리자를 먼저 지정해야 합니다.
- 같은 DataGSM 계정으로 다시 로그인하면 새 계정(약관 재동의)이 됩니다. 졸업·자퇴로 휴면(`INACTIVE`)이 된 계정은 탈퇴가 아니라 그대로 둡니다.
- 정지 중에 탈퇴하면 `withdrawn_suspensions`에 DataGSM 식별값·정지 종료일(영구 정지는 NULL)·사유만 남기고, 그 기간 동안 로그인하면 403 `AUTH_WITHDRAWN_SUSPENDED`(detail `{ until }`)입니다. 기간이 끝난 행은 로그인에서 무시하고 `daily-cleanup`이 지웁니다.

## 약관

관리자 API가 생기기 전까지는 `policies` 테이블에 직접 넣습니다.

```sql
INSERT INTO policies (id, type, version, title, content, required, require_reagreement, effective_at)
VALUES (UUID_TO_BIN(UUID()), 'TERMS', '1.0', '서비스 이용약관', '# 이용약관 ...', true, false, NOW(3));
```

- 필수(`required`) 약관에 동의하지 않은 사용자는 로그인 `nextStep`이 `TERMS_AGREEMENT`이고, 동의 전까지 대부분의 API가 403 `TERMS_AGREEMENT_REQUIRED`
- 새 버전을 넣을 때 `require_reagreement = true`면 기존 사용자도 다시 동의해야 함
- 서버는 약관 목록을 1분 캐시합니다.
- 공개 API(`@Auth('ALL')`)는 로그인 상태여도 약관 검사를 하지 않습니다.

## 단어팩

- 내 단어팩은 사용자당 50개, 이름은 1~30자이고 삭제되지 않은 내 팩끼리 겹칠 수 없습니다 (대소문자 무시).
- 기본 단어팩(`type=DEFAULT`)은 관리자만 만들고 고칩니다. 추천순은 기본 팩이면 `sort_order`, 내 팩이면 최근 수정순입니다.
- 삭제는 소프트 삭제(`deleted_at`)이고 공유 코드도 함께 지웁니다.
- 분류와 기본 단어팩은 시드 파일로 넣습니다(아래 "기본 단어팩 시드"). 금칙어는 관리자 API가 생기기 전까지 DB에 직접 넣고, 서버는 1분 캐시합니다.

```sql
INSERT INTO pack_categories (id, name, sort_order) VALUES (UUID_TO_BIN(UUID()), '수능', 1);
INSERT INTO forbidden_words (id, word, type) VALUES (UUID_TO_BIN(UUID()), '금칙어', 'FORBIDDEN');
INSERT INTO forbidden_words (id, word, type) VALUES (UUID_TO_BIN(UUID()), 'class', 'ALLOWED');
```

- 금칙어는 대소문자·전각·공백·기호를 무시한 부분 일치이고, 허용 단어(`ALLOWED`) 안에 든 경우는 통과합니다. 팩 이름·설명은 항상, 단어는 공유할 때 검사합니다.

### 기본 단어팩 시드

- 형식은 [seeds/default-packs.example.json](seeds/default-packs.example.json)을 따릅니다. `categories`(이름, 정렬 순서)와 `packs`(이름, 분류 이름, 설명, 정렬 순서, 단어)로 구성됩니다. 단어 규칙은 앱과 같습니다(영어 50자, 뜻 1~5개, 팩당 1000개, `example`·`derivatives`는 선택).
- 분류·팩은 이름으로, 단어는 팩 안에서 영어(대소문자 무시)로 찾습니다. 그래서 같은 파일을 여러 번 넣어도 결과가 같고, 파일을 고치면 바뀐 것만 반영됩니다.
- 파일에 없는 단어는 기본으로 남깁니다(관리자가 API로 추가한 단어 보호). `--prune`을 주면 파일에 없는 단어를 지웁니다(소프트 삭제).
- 파일에서 팩 이름을 바꾸면 새 팩이 만들어지고 예전 이름의 팩은 그대로 남습니다(학습 기록·오답이 그 팩을 가리킴). 이름을 바꾸려면 먼저 앱의 단어팩 수정 API로 바꾼 뒤 파일을 맞춥니다.
- 관리자가 API로 추가한 단어와 합쳐 팩당 1000개를 넘으면 그 팩은 반영하지 않고 실패합니다(팩마다 트랜잭션이라 다른 팩은 반영됨).
- 넣기 전에 `--dry-run`으로 형식만 검사할 수 있습니다. 잘못된 곳이 있으면 위치와 이유를 출력하고 아무것도 넣지 않습니다.

```bash
# 로컬
pnpm db:seed seeds/default-packs.json --dry-run
pnpm db:seed seeds/default-packs.json

# 서버 (seeds 폴더는 이미지에 들어 있음)
docker compose run --rm migrate dist/seed.js seeds/default-packs.json
```

### 단어

- 한 팩에 1000개까지. 영어 50자, 뜻 1~5개(각 100자, 중복 불가, 첫 번째가 대표 뜻)입니다.
- 같은 단어 판정은 대소문자·연속 공백·전각을 무시합니다 (`english_norm`, `utf8mb4_bin` 비교라 악센트는 구분).
- `POST /packs/{id}/words`는 여러 개를 한 번에 받습니다. 이미 있는 단어는 `duplicatePolicy`(SKIP·OVERWRITE)를 따르고, 요청 안에서 겹치면 처음 것만 씁니다. 한도를 넘는 단어는 에러 없이 `excluded`로 알려줍니다. `Idempotency-Key`를 지원합니다.
- `example`·`derivatives`는 기본 단어팩에만 저장하고, 내 단어팩에 보내면 버립니다.
- `POST /packs/{id}/words/parse`는 저장하지 않고 분석만 합니다. 줄마다 처음 나오는 `/`, `,`, 탭 앞이 영어, 뒤가 뜻(쉼표로 여러 개)이고 빈 줄은 건너뜁니다. 1000줄까지 받습니다.
- `POST /packs/{id}/words/import`(multipart `file`)는 CSV·XLSX를 분석만 하고 응답 형식은 parse와 같습니다. 클라이언트가 확인한 행을 `POST /packs/{id}/words`로 저장합니다.
  - 5MB·1000행까지, 1열 영어·2열 뜻. 첫 행이 머리글(`영어`, `단어`, `english` 등)이면 건너뜁니다.
  - 형식은 확장자가 아니라 내용으로 판단합니다 (`PK\x03\x04`면 XLSX, 아니면 UTF-8 CSV). EUC-KR CSV는 `WORD_FILE_ENCODING_INVALID`.
  - XLSX는 ZIP 중앙 디렉터리에서 필요한 파일만 풀고, 푼 크기를 `zlib`의 `maxOutputLength`로 제한합니다 (압축 폭탄 방어). 행이 한도를 넘으면 끝까지 읽지 않고 멈춥니다.
- 삭제는 소프트 삭제입니다 (오답노트·학습 기록이 단어를 참조).

### 공유·복사

- 내 단어팩만 공유할 수 있습니다. `POST /packs/{id}/share`는 이미 공유 중이면 같은 코드를 돌려주고, 단어가 없으면 `PACK_EMPTY`입니다.
- 공유를 켤 때 이름·설명·모든 단어를 금칙어로 다시 검사합니다. 걸리면 `detail.wordId`로 어떤 단어인지 알려줍니다. 공유 중에 추가·수정하는 단어도 검사합니다.
- 공유 코드는 헷갈리는 글자를 뺀 12자 무작위 문자열이고, 링크는 `{SHARE_LINK_BASE}/packs/shared/{코드}`입니다. 공유를 중지했다가 다시 켜면 새 코드가 생겨 예전 링크는 계속 무효입니다.
- 미리보기는 단어 20개까지, `memoryStatus`는 null입니다.
- 복사는 단어까지 통째로 복사한 독립된 내 팩을 만듭니다. 이름이 겹치면 ` (2)`, ` (3)`을 붙입니다. 같은 공유 팩은 한 번만 복사할 수 있고(`pack_copies`), 복사본을 지우면 다시 복사할 수 있습니다. 내가 공유한 팩은 복사할 수 없습니다 (`PACK_COPY_OWN`).

### 검색·즐겨찾기

- `GET /words/search?q=`는 기본 팩 + 내 팩에서 영어나 뜻에 검색어가 들어 있는 단어를 영어 알파벳순으로 돌려줍니다 (대소문자 무시, 부분 일치).
- 뜻은 JSON이라 검색용으로 이어 붙인 `meanings_text`를 따로 저장합니다. 단어를 저장·수정·복사하는 곳에서 함께 채워야 합니다.
- `FULLTEXT(english, meanings_text) WITH PARSER ngram`으로 후보를 좁히고 `LIKE`로 정확히 거릅니다. 2글자보다 짧은 낱말은 ngram 토큰(`ngram_token_size=2`)으로 잡히지 않아 `LIKE`만 씁니다.
  - FULLTEXT 인덱스는 Drizzle이 지원하지 않아 마이그레이션 SQL에만 있습니다. 스키마를 고쳐도 drizzle-kit이 이 인덱스를 알지 못합니다.
  - ngram 파서는 불용어(`a`, `on`, `is` …)가 들어간 토큰을 모두 버리기 때문에 불용어를 끈 채로 인덱스를 만듭니다. 인덱스를 다시 만들 때도 `SET SESSION innodb_ft_enable_stopword = OFF`를 먼저 실행해야 합니다.
- 즐겨찾기(`PUT`·`DELETE /words/{id}/favorite`)는 둘 다 멱등 204입니다. 기본 팩이나 내 팩의 단어만 즐겨찾기할 수 있고, 볼 수 없게 된 단어(삭제·남의 팩)는 목록에서 빠집니다.
- 단어 목록·검색 응답의 `favorite`은 보는 사람 기준입니다.

## 학습

- `POST /study/sessions`에서 서버가 문항과 보기를 만들어 `study_session_questions`에 고정 저장합니다. 이어하기(`GET /study/sessions/{id}`)는 저장된 순서를 그대로 돌려줍니다.
  - 문제 수는 10·20·30·전체이고, 단어 수보다 많으면 전체로 맞춥니다. `shuffle=false`면 단어팩 순서(즐겨찾기는 즐겨찾기한 순서)대로 앞에서부터 냅니다.
  - 4지선다 보기는 정답 + 그 단어의 단어팩에 있는 다른 단어 3개입니다. 보이는 글자(EN_TO_KO는 대표 뜻, KO_TO_EN은 영어)가 정답이나 다른 보기와 같은 단어는 뺍니다. 팩에서 모자라면 이번 학습의 다른 단어로 채우고, 그래도 모자라면 `STUDY_TOO_FEW_WORDS`입니다.
  - TYPING 정답(`accepted_answers`)은 서버에만 두고 내려주지 않습니다.
- 이어할 학습은 팩마다 하나(팩이 없는 즐겨찾기 등은 소스마다 하나)이고, `active_key` 생성 컬럼의 유니크 인덱스로 막습니다. 이미 있으면 `409 STUDY_SESSION_EXISTS`(`detail.sessionId`)이고, `force=true`면 기존 학습을 `ABANDONED`로 바꾸고 새로 만듭니다.
- 저장분은 `expires_at`(마지막으로 답한 뒤 7일)이 지나면 조회·이어하기에서 빠집니다. 같은 팩을 새로 시작하거나 정리 작업이 돌면 `ABANDONED`로 바뀝니다.
- `DELETE /study/sessions/{id}`는 행을 지우지 않고 `ABANDONED`로 바꿉니다.
- `POST /study/sessions/{id}/answers`는 문항마다 채점하고 답안·오답노트·암기 진행을 한 트랜잭션에 반영합니다. 세션 행을 잠가 같은 학습의 답안을 차례로 처리하고, 답을 낼 때마다 만료 시각을 7일 뒤로 늘립니다. `Idempotency-Key`를 지원합니다.
  - TYPING은 앞뒤 공백·대소문자·연속 공백을 무시하고, EN_TO_KO는 띄어쓰기도 무시하고 뜻 중 하나와 같으면 정답입니다.
  - `elapsedMs`가 500ms 미만이면 `counted=false`이고, 연속 정답(암기·오답 졸업)에 넣지 않습니다.
  - CHOICE·TYPING은 다시 내면 `409 STUDY_ANSWER_ALREADY_SUBMITTED`, FLASHCARD는 덮어씁니다.
- 오답노트(`wrong_notes`)는 (단어, 문제 유형)마다 한 행입니다. 틀리면 `wrong_count`를 올리고 연속 정답을 0으로 되돌립니다(졸업했던 항목은 다시 `ACTIVE`). 같은 문제 유형으로 2번 연속 맞히면 자동 졸업합니다. 플래시카드는 문제 유형이 없어 오답노트에 넣지 않습니다.
- 암기 상태(`user_word_progress`, 행이 없으면 NEW):
  - 처음 답하면 LEARNING이 됩니다. 서로 다른 학습에서 3번 연속 맞히면 MEMORIZED입니다(한 학습 안에서는 한 번만 셉니다).
  - 틀리면 연속 정답이 0이 되고, MEMORIZED였으면 LEARNING으로 내려갑니다. 플래시카드의 "알아요"는 정답으로 봅니다.
  - 단어 목록·검색·즐겨찾기의 `memoryStatus`, 단어 목록의 `memoryStatus` 필터, 단어팩의 `progress`·`lastStudiedAt`·`memoryStatusCount`가 이 표를 씁니다.
- `POST /study/sessions/{id}/complete`(`FINISHED`·`QUIT`)는 세션을 한 번만 `COMPLETED`로 바꾸고, 같은 트랜잭션에서 다음을 처리합니다. `Idempotency-Key`를 지원합니다.
  - 기록(`study_records`)과 답한 문항별 결과(`study_record_items`)를 남깁니다. 문항별 결과에는 영어·뜻을 스냅샷으로 저장합니다.
  - 일별 통계(`daily_study_stats`, `daily_studied_words`)를 KST 날짜 기준으로 쌓습니다. 답을 하나도 내지 않은 학습은 통계와 스트릭에서 뺍니다.
  - 스트릭과 XP를 갱신합니다.
- 스트릭(`user_streaks`, `kind=STUDY`)은 답을 1개 이상 낸 학습을 끝내면 그날(KST)을 인정합니다. 어제 이어서 하면 +1, 하루 이상 비면 1부터 다시 셉니다.
- XP는 `xp_ledger` 원장 하나에 모든 출처를 기록합니다. `(사용자, 출처, ref_key)` 유니크로 중복 지급을 막고, `XpService.grant`가 사용자 행을 잠가 하루(KST) 500 상한을 지킵니다. 상한에 걸려 0이 된 지급도 원장에 남깁니다.
  - 학습: 정답당 4지선다 +1, 직접 입력 +2, 오답노트 복습 +1입니다. 너무 빠른 답과 플래시카드는 0입니다.
  - 완주 +10: 팩의 모든 단어를 4지선다·직접 입력으로 `FINISHED`까지 풀면 받습니다(오답이 있어도 됨). 같은 팩은 하루 1회입니다(`ref_key = pack:{packId}:{date}`).
  - `blockedReason`은 사유가 여러 개면 `DAILY_CAP` → `REPEAT_LIMIT`(완주 보너스를 오늘 이미 받음) → `TOO_FAST` → `NOT_COMPLETED`(그만두기) 순으로 하나만 알려줍니다.
- 소스는 `PACK`·`FAVORITE`·`WRONG_NOTE`·`RECORD_WRONG`·`REVIEW` 다섯 가지입니다.
  - `RECORD_WRONG`은 그 기록에서 틀린 단어(4지선다·직접 입력)나 "몰라요"(플래시카드)를 출제 순서대로 냅니다. 남의 기록이면 403, 없으면 `RECORD_NOT_FOUND`입니다.

### 간격 반복 복습

- `user_word_progress`의 `review_stage`·`next_review_on`(KST)으로 일정을 관리합니다. 간격은 1·3·7·14·30일입니다.
  - 처음 답한 단어는 다음 날 복습할 단어가 됩니다.
  - 복습 학습(`source=REVIEW`)에서 복습일이 된 단어를 맞히면 다음 간격으로 넘어가고, 30일 간격까지 통과하면 일정에서 빠집니다(`next_review_on = NULL`).
  - 어디서든 틀리면 다음 날부터 다시 시작합니다. 일반 학습에서 맞힌 것과 너무 빠른 정답은 일정을 바꾸지 않습니다.
- `GET /study/review`는 오늘 복습할 단어 수(최대 30)와 오늘 복습 학습에서 답한 단어 수(`last_reviewed_on`)를 돌려줍니다. `source=REVIEW`는 복습일이 이른 순으로 30개까지 냅니다. 내가 지운 팩·단어는 복습하지 않습니다.

### 기록·통계

- `GET /records`는 최신순이고 `date`(KST)로 그날 기록만 볼 수 있습니다. 팩이 삭제됐거나 팩 학습이 아니면 `pack`의 두 값이 모두 null입니다.
- `GET /records/{id}`는 답한 문항만 돌려줍니다. 영어·뜻은 학습을 끝낸 시점의 스냅샷입니다.
- `GET /stats/streak`의 `current`는 오늘이나 어제까지 이어졌을 때만 저장된 값이고, 끊겼으면 0입니다.
- `GET /stats/calendar?month=YYYY-MM`은 `daily_study_stats`에서 학습한 날만 돌려줍니다. 미래의 달은 400입니다.
- `GET /stats/summary?period=`의 기간은 다음과 같습니다(KST, 오늘까지).
  - `TODAY`: 오늘
  - `WEEK`: 이번 주 월요일부터
  - `MONTH`: 이번 달 1일부터
  - 정답률은 4지선다·직접 입력만으로 계산합니다. `studiedWordCount`는 기간 안의 서로 다른 단어 수입니다(`daily_studied_words`). 그래프(`series`)는 기간 첫날부터 오늘까지 하루씩 채웁니다.

### 오답노트

- `GET /wrong-notes`는 기본으로 `ACTIVE`를 최근에 틀린 순(`last_wrong_at`)으로 보여줍니다. `sort=MOST_WRONG`이면 틀린 횟수 순입니다. 커서는 정렬 키마다 따로 인코딩합니다.
  - 필터: `status`·`questionType`·`packId`·`source`, `from`·`to`(KST 날짜, 마지막으로 틀린 날 기준), `recordId`.
  - `recordId` 필터는 그 기록의 문항별 결과에서 같은 단어·같은 문제 유형으로 틀린 오답을 찾습니다. 남의 기록이면 아무것도 나오지 않습니다.
  - 삭제된 단어의 오답은 다시 풀 수 없어 목록에서 뺍니다. 팩만 삭제됐으면 `pack=null`로 보여줍니다.
- `POST /wrong-notes/delete`(영구 삭제)와 `POST /wrong-notes/graduate`(수동 졸업)는 한 번에 500개까지 받고, 남의 id는 조용히 무시합니다.
- 오답노트로 다시 풀기(`source=WRONG_NOTE`)는 `ACTIVE` 오답이 있는 단어를 최근에 틀린 순으로 한 번씩만 냅니다. 팩이 삭제돼도 단어가 남아 있으면 낼 수 있습니다. 정답 XP는 방식과 상관없이 +1입니다.

## 랭킹

- XP를 주면 같은 트랜잭션에서 `users.total_xp`를 올리고, 커밋된 뒤 `RankingService.addXp`로 Valkey ZSET에 반영합니다. 롤백된 XP가 랭킹에 남지 않게 하기 위해서이고, 새로 XP를 주는 곳도 같은 순서를 따라야 합니다.
- 키는 `rank:{weekly|monthly|all}:{기간}:{범위}`입니다.
  - 기간: 주간은 그 주 월요일(KST), 월간은 `YYYY-MM`, 전체는 `all`
  - 범위: `school`, `grade:{학년}`, `class:{학년}-{반}`
  - 지난 주간 키는 60일, 월간 키는 400일 뒤 만료됩니다(시즌 스냅샷이 남은 뒤).
- 점수는 `XP × 10^10 + (10^10 - 1 - 도달 시각 초)`입니다. XP가 같으면 먼저 그 점수에 도달한 사용자가 위에 옵니다. 여러 키를 Lua 스크립트 하나로 원자적으로 갱신합니다.
- 교사는 넣지 않고, 학년·반이 없는 학생은 학교 범위에만 들어갑니다. 학년·반이 바뀌면 그 뒤에 얻은 XP부터 새 학년·반에 쌓입니다.
- 랭킹 비공개 사용자도 ZSET에는 넣고(본인 순위 계산용), 목록에서 거릅니다.
- `GET /ranking`은 이번 기간(KST) ZSET에서 상위 100명을 계산해 `rank:top:{키}`에 5분 동안 캐시합니다(`updatedAt`). 학생·활동 중·랭킹 공개인 사용자만 넣고, 순위는 그 사람들끼리 다시 매깁니다.
  - GRADE·CLASS는 조회하는 사람의 학년·반 기준이고, 교사는 SCHOOL만 볼 수 있습니다(나머지는 403).
  - 반 랭킹은 공개 참여자(XP 1 이상)가 3명 미만이면 `available=false`입니다.
  - FRIENDS는 나 + 친구를 학교 범위 점수로 비교합니다. 친구 기능 전까지는 나만 나옵니다.
- `GET /ranking/me`(학생만)는 캐시 없이 지금 값으로 계산합니다. 비공개 사용자도 공개 사용자 사이에 자기를 끼워 순위를 봅니다. 100위 밖이면 `rank` 대신 `topPercent`(올림)를 주고, `change`는 지난 기간 ZSET의 순위와 비교한 변동입니다(양수면 상승).
- 시즌 마감: 주간·월간 기간 하나가 시즌 하나입니다(`ranking_seasons`). BullMQ `ranking` 큐의 `close-seasons` 작업이 매시 10분(KST)에 돕니다.
  - 끝났는데 확정하지 못한 시즌(`CLOSED_PENDING`·`FAILED`)을 마감하고, 그 기간의 학교·학년·반 ZSET을 `ranking_snapshots`에 남긴 뒤 `CONFIRMED`로 바꿉니다.
  - 실패하면 `FAILED`·`last_error`를 남기고 다음 시간에 다시 시도합니다. 서버가 꺼져 있던 동안의 시즌도 주간 4주·월간 2달까지 따라잡습니다(지난 ZSET이 만료되기 전).
  - 스냅샷 순위는 목록에 보이는 사람끼리 셉니다. 비공개 등 목록에 없던 사람은 자기를 그 사이에 끼워 넣은 순위를 받습니다(`listed=false`).
  - 관리자가 시즌에서 제외한 사용자(`ranking_season_exclusions`)는 `rank`가 null이고 아무의 순위에도 세지 않습니다. 마감할 때(다시 돌릴 때도) 시즌 행을 잠근 뒤 제외 대상을 읽어 반영합니다. 스냅샷에는 마감 순서(`position`)를 남겨, 제외가 바뀌면 XP 동점 순서를 지킨 채 다시 매깁니다. 주간 결과 알림과 `/ranking/me`의 `change`도 제외된 사용자에게는 순위를 주지 않습니다.
  - `/ranking/me`의 `change`는 직전 시즌이 확정됐으면 그 스냅샷 순위로, 아직이면 지난 기간 ZSET에서 계산합니다.
  - 시즌 배지·주간 결과 알림은 시즌을 `CONFIRMED`로 바꾸는 곳(`SeasonService.close`)에 붙입니다.
- `PATCH /users/me/privacy`(학생만)는 공개 설정과 함께 `ranking_onboarded`를 true로 바꿉니다. 랭킹 첫 진입 안내와 설정 화면이 같이 씁니다. ZSET은 건드리지 않습니다.
- `GET /users/me/xp-history`(학생만)는 XP 원장을 최신순으로 보여줍니다. 하루 상한에 걸려 0이 된 지급도 `blockedReason`과 함께 보여주고, 관리자 조정은 음수입니다.
- Valkey가 날아가면 `pnpm ranking:rebuild`(서버는 `docker compose run --rm migrate dist/ranking-rebuild.js`)로 원장에서 다시 만듭니다. 학년·반은 지금 값으로 넣습니다.

## 홈

- `GET /home`은 복습 수, 이어할 학습, 스트릭, 이번 주 학교 순위, 추천 단어팩을 한 번에 내려주는 묶음 API입니다. 각 칸은 기존 서비스(`StudySessionsService`, `RecordsService`, `RankingQueryService`, `PacksService`)를 병렬로 부릅니다.
- 한 칸이 실패해도 나머지는 내려주고, 실패한 칸은 null(추천 팩은 빈 배열)로 두고 로그를 남깁니다.
- 이어할 학습이 팩 학습이 아니면 `packName`에 학습 종류 이름(즐겨찾기·오답노트·틀린 단어·오늘의 복습)을 넣습니다.
- 추천 단어팩은 학습 기록이 하나도 없는 사용자에게만 기본 단어팩 추천순 5개를 줍니다. 교사는 주간 순위가 null입니다.
- 오늘의 문장(`morning`)과 미션(`missions`)은 기능이 생기기 전까지 null입니다.

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

## 알림

- `notifications`에 받은 알림을 저장하고 30일 보관합니다(목록·안 읽은 수도 30일 안만, 지난 것은 매일 정리에서 지움). 목록은 UUIDv7 id 역순 커서입니다.
- 다른 기능은 `NotificationsService.notify(userIds, { type, title, body, route })`로 알림을 보냅니다. 저장한 알림을 돌려주며 푸시는 이것으로 보냅니다.
  - 알림 종류마다 설정 분류가 있고(`CATEGORY_OF`), 그 분류를 끈 사용자에게는 저장하지 않습니다. 광고성(`MARKETING`)은 마케팅 수신 동의를 철회했으면 켜 둔 설정과 상관없이 보내지 않습니다.
  - 친구·배지·문의 답변·제재·새 기기 로그인처럼 계정·관계에 관한 알림은 끌 수 없습니다. 정지·탈퇴·휴면 계정에는 저장하지 않고, 받는 사람이 많으면 1000명씩 나눠 저장합니다.
- 약관 재동의 전·교사 담당 반 선택 전에도 알림 API는 쓸 수 있습니다(끌 수 없는 알림·약관 변경 공지를 볼 수 있게). 마케팅 동의를 철회하면 설정 조회에서 광고성이 꺼진 것으로 보입니다.
- `notification_settings`는 계정 단위(모든 기기 공통)입니다. 행이 없으면 기본값: 광고성만 끄고 모두 켬, 학습 리마인더 시간 없음(보내지 않음), 요일은 매일.
- 학습 리마인더 시간은 KST `HH:mm`, 07:00~22:00만(400 `NOTI_REMINDER_TIME_OUT_OF_RANGE`). 광고성을 켜려면 마케팅 수신 동의가 있어야 합니다(400 `NOTI_MARKETING_AGREEMENT_REQUIRED`).

## 푸시

- APNs(HTTP/2 토큰 인증)·FCM(HTTP v1, 서비스 계정 OAuth)·Web Push(VAPID)를 서버가 직접 보냅니다. 키는 환경 변수이고, **키가 없는 플랫폼은 보내지 않고 기록만** 합니다(알림 목록에는 그대로 저장).
- 알림을 저장하면(`NotificationsService.notify`) 받는 사람의 쓰는 기기(로그아웃하지 않았고 푸시를 등록한 기기)마다 `push` 큐에 작업을 넣고, 작업이 기기별로 보냅니다(3번까지 재시도).
  - 야간(22:00~07:00 KST)에는 보내지 않고, 광고성은 21:00~08:00에 보내지 않습니다. 미뤄 보내지 않으며 알림 목록에만 남습니다. 재시도하다 금지 시간에 들어가도 보내지 않습니다.
  - 해지된 토큰(APNs 410, FCM `UNREGISTERED`, Web Push 404·410, 암호화할 수 없는 구독 키)이면 그 기기의 푸시 등록을 지웁니다. APNs `BadDeviceToken`·`DeviceTokenNotForTopic`과 FCM 404·`SENDER_ID_MISMATCH`는 서버·번들 ID·프로젝트 설정이 틀려도 모든 토큰에 오므로 지우지 않고 기록만 합니다. 보내는 사이 새 토큰으로 바뀌었으면 지우지 않습니다.
  - 속도 제한·서버 오류·인증 토큰 만료는 재시도하고, 다시 보내도 안 되는 오류는 기록만 합니다.
- 로그아웃·탈퇴하면 기기의 푸시 등록이 함께 지워집니다. 웹 푸시 구독은 등록할 때 키 길이(p256dh 65바이트, auth 16바이트)를 검사합니다. 시작할 때 키가 빠진 플랫폼을 경고로 남깁니다.

## 친구

- 학생끼리만 맺습니다(교사 403 `FRIEND_NOT_ALLOWED`, 정지·탈퇴·휴면이거나 없는 사용자 404 `USER_NOT_FOUND`). 한도는 `FRIEND_LIMIT`(임시 100명)이고 요청·수락 때 양쪽 모두 확인합니다.
- `friend_requests`는 보낸 사람→받는 사람 한 쌍에 하나, `friendships`는 방향마다 한 행(양쪽 두 행)입니다. 친구 삭제는 두 행을 함께 지웁니다.
- 상대가 이미 나에게 요청했으면 요청을 만들지 않고 바로 친구가 되며(`requestId: null`), 먼저 요청한 사람에게 수락 알림을 보냅니다.
- 요청·수락은 두 사용자 행을 id 순서로 잠가 서로 동시에 요청해도 한쪽만 처리되고 한도를 넘지 않습니다. 거절·취소는 상대에게 알리지 않습니다.
- 친구 목록은 친구가 된 순서(최근 먼저)이고 페이지네이션이 없습니다. 랭킹 `FRIENDS` 범위는 나와 친구입니다.

## 차단

- 학생이 다른 학생을 차단합니다(교사 403 `BLOCK_NOT_ALLOWED`, 탈퇴했거나 없는 사용자 404 `USER_NOT_FOUND`). 상대에게 알리지 않고, 차단 목록은 차단한 사람만 봅니다.
- 차단하면 두 사람의 친구 관계와 대기 중인 친구 요청(양쪽 방향)을 지웁니다. 풀어도 친구는 되살리지 않습니다. 친구 요청·수락과 같은 순서로 두 사용자 행을 잠가 차단과 동시에 친구가 되지 않습니다.
- 어느 쪽이든 차단했으면 친구 요청이 403 `FRIEND_NOT_ALLOWED`(차단 사실을 드러내지 않는 같은 문구)이고, 빠른 매칭에서 서로 짝짓지 않습니다.
- 대결방 리액션은 보낸 사람을 차단한 사람에게 보내지 않습니다. 초대 코드로 같은 방에 들어오는 것은 막지 않습니다.

## 사용자 검색·프로필

- 사용자 검색(`GET /users/search`)은 친구 추가용이라 학생만 씁니다. 이름(가운데 글자 포함) 또는 학번(앞부분)으로 찾고 이름순 cursor 페이지입니다. 응답에 학번은 넣지 않고(랭킹 비공개면 티어도 null) 친구 여부와 대기 중인 친구 요청 방향(`RECEIVED`·`SENT`)을 붙입니다.
- 교사, 나, 나를 차단한 사용자, 정지·휴면·탈퇴 계정은 검색에서 빠집니다. 내가 차단한 사용자는 나옵니다(차단을 풀 수 있게).
- 프로필(`GET /users/{userId}`)은 교사도 봅니다. 랭킹 비공개이거나 정지·휴면 계정이면 남에게는 레벨·티어가 null이고(사용자 요약의 티어도 null), 내 프로필은 보입니다. 교사는 레벨·티어가 없습니다.
- 탈퇴한 사용자는 이름이 "탈퇴한 사용자"이고 학년·반·레벨·티어·대표 배지가 null입니다. 나를 차단한 사용자와 없는 사용자는 똑같이 404 `USER_NOT_FOUND`입니다. 관계(`relation`)의 `isBlocked`는 내가 차단했는지입니다.
- 대표 배지는 배지 목록과 같게 공개 프로필과 내 프로필에서만 보입니다. 숨긴 배지나 더는 갖고 있지 않은 배지는 null입니다.

## 신고

- 로그인한 사용자는 사용자·단어팩·단어를 신고합니다(`POST /reports`). 사유는 부적절한 내용·불쾌한 리액션·부정행위·기타이고, 기타는 상세가 필수(200자 이하, 앞뒤 공백 제거)입니다.
- 나 자신·내 단어팩(그 안의 단어)은 400 `REPORT_SELF`, 없거나 탈퇴했거나 내가 볼 수 없는 대상(공유하지 않은 남의 단어팩)은 404 `REPORT_TARGET_NOT_FOUND`입니다.
- 대결 중 일어난 일이면 `battleId`를 붙이고, 내가 참여한 대결이 아니면 404 `BATTLE_NOT_FOUND`입니다.
- 같은 대상·사유는 하루(KST) 한 번입니다(429 `REPORT_DUPLICATE_TODAY`). 유니크 키로 막아 동시에 보내도 하나만 남습니다.
- 신고는 `RECEIVED` 상태로 쌓이고, 처리·결과 알림은 관리자 기능에서 합니다. 신고 대상에게는 알리지 않으며 신고한 사람을 드러내는 API가 없습니다.

## 오늘의 문장

- 하루 경계는 **06:00 KST**입니다(`morningDate`). 06시 전에는 전날 문장이 "오늘"이고, XP 지급 여부(문장 날짜당 한 번)와 연속 기록도 같은 기준입니다. 하루 XP 상한(500)은 다른 XP처럼 자정 기준입니다.
- `PUBLISHED`이면서 날짜가 오늘 이전인 문장만 보입니다. 미래·게시 전·없는 날짜는 404 `MORNING_NOT_FOUND`이고, 오늘 문장이 없으면 `GET /morning/today`가 가장 최근 문장을 `isFallback: true`로 줍니다(하나도 없으면 404, 홈 카드는 null).
- 퀴즈 완료(`POST /morning/{date}/quiz/complete`, 학생, Idempotency-Key)는 모든 문항에 한 번씩 답해야 합니다(400). 빈칸은 앞뒤 공백 제거·대소문자 무시로 허용 정답과 비교합니다.
  - 정답을 미리 내려주므로 XP는 정답 수와 상관없이 **오늘 문장을 처음 끝냈을 때 하루 한 번**(`MORNING_XP`, 임시 10)입니다. 지난 문장은 완료 기록만 남고 XP·연속 기록이 없습니다.
  - 아침 문장 연속 기록은 학습 연속 기록과 따로 `user_streaks`(`MORNING`)에 쌓입니다.
- 핵심 어휘 저장(`POST /morning/{date}/save-words`, 학생, Idempotency-Key)은 `packId`(내 단어팩, 기본·남의 단어팩은 404)와 `newPackName`(새 팩) 중 하나만 받습니다. 새 팩에 넣다 실패하면 만든 팩을 지웁니다. 이미 있는 단어는 건너뛰고, 한도(1000개)를 넘으면 하나도 넣지 않고 409 `PACK_WORD_LIMIT_EXCEEDED`입니다.
- 강조 위치(`highlight`)는 문장 안 UTF-16 코드 단위이고 `end`는 포함하지 않습니다(JavaScript 문자열 인덱스와 같음).

### 오늘의 문장 시드

- 문장 등록·검수·게시 예약은 관리자 기능에서 합니다. 그 전까지는 시드 파일로 넣습니다. 형식은 [seeds/morning.example.json](seeds/morning.example.json)을 따릅니다.
- 날짜마다 게시 상태로 넣고, 이미 있는 날짜는 내용과 핵심 어휘·퀴즈를 바꿉니다(사용자의 완료 기록은 그대로). 핵심 어휘는 단어 추가와 같은 규칙으로 정규화합니다. 강조 위치가 문장 밖이거나, 핵심 어휘가 겹치거나, 빈칸 정답이 문장에 없거나, 객관식 정답이 보기에 없으면 거절합니다. 이미 게시된 날짜의 퀴즈 수를 바꾸면 옛 문항으로 푸는 앱은 400을 받습니다.

```bash
pnpm db:seed-morning seeds/morning.json --dry-run
pnpm db:seed-morning seeds/morning.json

# 서버
docker compose run --rm migrate dist/seed-morning.js seeds/morning.json
```

## 미션

- 미션 정의는 `missions` 테이블의 데이터입니다(종류·목표·보상 XP, `active`로 끄기). 처음 7개는 마이그레이션으로 넣었고 수치는 임시입니다.

| 코드            | 기간 | 세는 활동                | 목표 | 보상 XP |
| --------------- | ---- | ------------------------ | ---- | ------- |
| `DAILY_STUDY`   | 일일 | 학습 끝내기              | 1    | 10      |
| `DAILY_WORDS`   | 일일 | 학습한 단어 수           | 20   | 10      |
| `DAILY_BATTLE`  | 일일 | 대결 끝까지 하기         | 1    | 10      |
| `DAILY_MORNING` | 일일 | 오늘의 문장 퀴즈         | 1    | 5       |
| `WEEKLY_STUDY`  | 주간 | 학습 끝내기              | 5    | 30      |
| `WEEKLY_WIN`    | 주간 | 대결 승리                | 3    | 30      |
| `WEEKLY_XP`     | 주간 | 얻은 XP (미션 보상 제외) | 300  | 50      |

- 진행(`user_missions`)은 기간 키(일일은 KST 날짜, 주간은 그 주 월요일)마다 한 줄이라, 자정·월요일 자정이 지나면 따로 초기화하지 않아도 새로 셉니다. 단, 오늘의 문장 미션은 문장이 바뀌는 06:00 기준 날짜로 셉니다(같은 문장을 두 날에 세지 않게). 목록은 이번 기간만 보여 주므로 `EXPIRED`는 나오지 않습니다.
- 활동이 생긴 트랜잭션 안에서 `addMissionProgress`로 진행을 올립니다(목표에서 멈춤).
  - 학습: 답을 낸 학습을 끝냈을 때 1회, 그 학습에서 답한 수만큼 단어 수.
  - 대결: 한 문항이라도 답하고 끝까지 남았을 때 완주, `WIN`일 때 승리(기권승은 세지 않음).
  - 오늘의 문장: 오늘 문장을 처음 끝냈을 때.
  - XP: `XpService.grant`에서 실제로 받은 양(미션 보상 제외).
- 보상(`POST /missions/{missionId}/claim`)은 이번 기간에 한 번입니다. 사용자 행을 잠근 뒤 `claimed_at IS NULL AND progress >= target` 조건부 업데이트로 두 번 받지 않게 하고, XP(출처 `MISSION`, 하루 500 상한 포함)를 같은 트랜잭션에서 줍니다. 상한에 걸려 일부만 받아도 받은 것으로 끝납니다. 404 `MISSION_NOT_FOUND`, 409 `MISSION_NOT_CLAIMABLE` / `MISSION_ALREADY_CLAIMED`.
- 진행을 올리는 쪽도 사용자 행을 먼저 잠가, 보상 수령과 잠그는 순서가 같습니다. 홈 화면 `missions`는 일일 미션입니다(교사는 null).

## 배지

- 배지 정의는 `badges` 테이블의 데이터입니다(이름·설명·안내 문구·이미지 키). 업적 배지는 `metric` 값이 `threshold` 이상이면 줍니다. 처음 9개는 마이그레이션으로 넣었고 조건 수치와 이미지는 임시입니다.

| 코드          | 이름          | 조건                      |
| ------------- | ------------- | ------------------------- |
| `FIRST_STUDY` | 첫걸음        | 학습 1회                  |
| `STUDY_100`   | 꾸준한 학습자 | 학습 100회                |
| `STREAK_7`    | 일주일 연속   | 학습 최고 연속 7일        |
| `STREAK_30`   | 한 달 연속    | 학습 최고 연속 30일       |
| `XP_1000`     | XP 1,000      | 누적 XP 1,000             |
| `XP_10000`    | XP 10,000     | 누적 XP 10,000            |
| `FIRST_WIN`   | 첫 승리       | 대결 승리 1번             |
| `WIN_50`      | 대결의 달인   | 대결 승리 50번            |
| `MORNING_7`   | 아침형 인간   | 오늘의 문장 최고 연속 7일 |

- 학습 완료·대결 종료(끝까지 남은 사람)·오늘의 문장·미션 보상·오늘의 챌린지가 커밋된 뒤 `BadgesService.evaluate`로 아직 없는 업적 배지의 조건을 모두 다시 봅니다. 유니크 키로 한 번만 주고, 새로 얻으면 `BADGE_EARNED` 알림(끌 수 없음)을 보냅니다. 평가가 실패해도 요청은 성공하고, 아직 주지 못한 배지는 다음 활동에서 다시 봅니다(배지는 줬지만 알림이 실패한 경우는 다시 보내지 않음).
- `GET /badges?userId=`: 내 배지는 전체와 획득 여부, 다른 사람은 획득한 것만입니다. 랭킹 비공개 사용자는 빈 배열, 없거나 탈퇴한 사용자는 404 `USER_NOT_FOUND`입니다.
- 시즌 배지(`SEASON`)는 랭킹 시즌 보상 규칙이 정해지면 시즌 마감에서 줍니다.

## 예약 알림

`scheduled-notifications` 큐의 반복 작업(KST)입니다. 작업은 처리된 시각이 아니라 예정된 시각 기준으로 보냅니다(늦게 처리돼도 그 분의 리마인더를 보냄). 같은 작업이 두 번 돌아도(서버 여러 대) Valkey 표시로 한 번만 보내고, 실패하면 표시를 지워 다음 실행에서 다시 보낼 수 있게 합니다(재시도는 하지 않음).

| 작업                 | 주기 (KST)              | 내용                                                                                                                                                     |
| -------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `study-reminder`     | 매분                    | 이 시각·요일로 리마인더를 정한 사용자 가운데 오늘 학습하지 않은 사람에게 `STUDY_REMINDER` (계정 단위라 기기가 여러 대여도 알림 하나)                     |
| `morning-publish`    | 매일 06:00              | 날짜가 된 예약(`SCHEDULED`) 문장을 게시                                                                                                                  |
| `morning-sentence`   | 매일 07:00              | 오늘 게시된 문장이 있으면 아직 풀지 않은 학생에게 `MORNING_SENTENCE`                                                                                     |
| `rank-weekly-result` | 월요일 08:00~12:00 매시 | 지난주 시즌이 확정됐으면 학교 순위를 `RANK_WEEKLY_RESULT`로 한 번                                                                                        |
| `rank-drop`          | 매일 20:00              | 이번 주 반 순위를 지난 확인과 비교해 3계단(임시) 이상 내려가면 `RANK_DROP`. 랭킹 화면처럼 목록에 보이는 학생 사이의 순위이고, 주의 첫 확인은 기준만 남김 |

- 대결: 끝까지 남은 참가자에게 `BATTLE_RESULT`(결과 화면으로), 다시 하기로 새 방을 만들면 지난 대결의 다른 참가자에게 `BATTLE_INVITE`(새 대기실로, 차단 관계 제외)를 보냅니다. 대결 중 배너를 숨기는 것은 앱이 합니다.
- 알림 설정·야간 금지 시간은 알림·푸시 규칙을 그대로 따릅니다(끈 분류는 저장하지 않고, 야간에는 푸시 없이 목록에만).

## 관리자

- 관리자 API는 `/admin` 아래이고 `@Auth('ADMIN')`(관리자 권한이 있는 사용자)만 씁니다. 관리자 기능은 `src/modules/admin/`에 모읍니다.
- 관리자 행동은 바꾸는 작업과 같은 트랜잭션에서 `AuditLogService.record`로 감사 로그에 남깁니다(행위자·행동·대상·상세·IP·User-Agent). 교사 담당 반 변경도 남깁니다.
- `GET /admin/audit-logs`: 행위자·대상·행동·기간(KST 날짜, 양 끝 포함)으로 걸러 최신순 페이지로 봅니다.

### 사용자 관리

- `GET /admin/users`(학번 앞부분·이름 포함 검색, 역할·관리자·상태 필터)와 `GET /admin/users/{userId}`(학습·대결 요약, 받은 신고 수, 담당 반). 개인정보 열람이라 조회도 감사 로그에 남깁니다.
- 관리자 권한은 학생·교사 모두에게 줄 수 있습니다. 담당 반 수정만 교사 전용입니다(409 `ADMIN_NOT_TEACHER`). 학생 관리자가 졸업·자퇴로 나와도 활동 중인 관리자가 그 사람뿐이면 학적 동기화·로그인에서 휴면 처리하지 않고 남깁니다(관리자 API로는 되돌릴 수 없어서). 다른 관리자를 정하면 다음 동기화 때 휴면 처리됩니다. 관리자 행을 모두 잠근 뒤(`is_admin` 인덱스로 관리자 행만) 세어, 동시에 회수해도 활동 중인 관리자가 한 명은 남습니다(409 `ADMIN_LAST_ADMIN`).
- 교사 담당 반은 교사가 직접 바꾸는 것과 같은 처리를 쓰고, 감사 로그 행위자는 관리자입니다.
- XP 조정(`POST /admin/users/{userId}/xp-adjustments`, Idempotency-Key)은 한 번에 ±100,000까지, 사유 필수, 조정 뒤 0 미만이면 400 `ADMIN_XP_NEGATIVE`입니다. 원장에 `ADMIN_ADJUST`로 남고, 하루 상한을 적용하지 않으며 상한 계산과 결과 화면의 오늘 합계(`todayTotal`)에도 넣지 않습니다(XP 내역·랭킹 재구성에는 들어감). 랭킹은 0 아래로 내려가지 않게 조정하고 늘어날 때만 도달 시각을 바꿉니다.

### 제재

- `POST /admin/sanctions`(Idempotency-Key): 경고·XP 회수·정지(기간 필수)·영구 정지. 사유는 필수이고 사용자에게 안내됩니다. 자기 자신은 409 `ADMIN_SELF_ACTION`입니다.
  - 경고·XP 회수는 `SANCTION` 알림을 보냅니다. XP 회수는 가진 만큼만 `ADMIN_ADJUST`(음수)로 회수하고 랭킹에도 반영합니다.
  - 정지·영구 정지는 계정을 `SUSPENDED`로 바꾸고 모든 기기에서 로그아웃시킵니다. 이미 받은 액세스 토큰도 Valkey 차단 표시(`auth:blocked:{userId}`, 토큰 수명만큼)로 바로 막고(403 `ACCOUNT_SUSPENDED`), 열린 WebSocket은 다음 메시지에서 끊습니다(닫힘 코드 4403). 차단 표시는 커밋 전에 두고 실패하면 지웁니다. Valkey가 응답하지 않으면 차단 확인은 통과시킵니다(리프레시는 계정 상태로 막힘). 사유와 기간은 로그인할 때 안내됩니다.
  - 정지 기간이 지나면 다음 로그인 때 활동 상태로 돌아옵니다.
- `PATCH /admin/users/{userId}/status`: 정지는 제재와 같은 처리(기간이 없으면 영구 정지)이고, 해제(`ACTIVE`)는 정지와 차단 표시만 풉니다(409 `ADMIN_NOT_SUSPENDED`). 제재 이력은 사용자 상세에 최신순으로 나옵니다.

### 신고 처리

- 신고는 대상별 묶음(`report_groups`)에 쌓입니다. 대상마다 열린 묶음은 하나이고(`(대상, open_key)` 유니크, 동시에 신고해도 하나만 생김), 처리를 끝내면 묶음을 닫아 그 뒤의 신고는 새 묶음이 됩니다.
- `GET /admin/reports`(상태·사유·마지막 신고 기간 필터, 최근 신고순)와 `GET /admin/reports/{reportGroupId}`(개별 신고, 대상이 받은 신고 전체 수와 제재 이력, 처리 결과·변경 이력). 신고한 사람은 관리자에게도 보여 주지 않습니다.
- `PATCH /admin/reports/{reportGroupId}`: 완료(`RESOLVED`)에는 결과·메모가 필수입니다. 처음 완료할 때 신고한 사람들에게 `REPORT_RESULT` 알림을 한 번 보냅니다(문제 없음 / 조치함). 완료한 뒤에는 결과·메모만 고칠 수 있고(409 `REPORT_ALREADY_RESOLVED`), 바꿀 때마다 이력·감사 로그가 남습니다. 제재는 `POST /admin/sanctions`를 `reportGroupId`와 함께 따로 호출합니다.

### 부정 의심 사용자

- 매일 04:30(KST) `suspicious` 큐 작업이 전날 활동을 보고 `suspicious_flags`에 표시만 합니다. 제재는 관리자가 정합니다. `POST /admin/jobs/SUSPICIOUS_DETECT/run`으로 직접 돌려도 전날 기준이고, 같은 사용자·사유·날짜는 한 번만 표시합니다(유니크 키, 다시 돌려도 이미 있는 표시는 그대로).
- 기준(임시값, `src/modules/suspicious/suspicious-rules.ts`):
  - `FAST_ANSWERS`: 그날 학습 답이 30개 이상이고, 그중 너무 빨리 낸 답(0.5초 미만, 점수·XP에서 빠지는 답)이 절반 이상
  - `REPEATED_OPPONENT`: 같은 상대와 하루에 4번 이상 대결(XP는 3번까지만 받음). 두 사람 모두 표시
  - `XP_SPIKE`: 하루 XP 상한(500, 관리자 조정 제외)을 3일 이상 연속으로 채움
- `GET /admin/suspicious-users`: 사용자·활동한 날별로 묶어(사유 목록, 사유별 근거 수치, 처음 감지한 시각, 모두 확인했는지) 최근 날짜부터 보여 줍니다. 사유·확인 여부·활동 날짜 기간으로 거릅니다.
- `PATCH /admin/suspicious-users/{userId}/{date}`: 그날 그 사용자의 표시를 모두 확인함(또는 취소)으로 바꾸고 확인한 관리자·시각과 감사 로그를 남깁니다(404 `SUSPICIOUS_NOT_FOUND`).

### 금칙어 관리

- `GET/POST /admin/forbidden-words`, `PATCH/DELETE /admin/forbidden-words/{wordId}`: 금칙어(`FORBIDDEN`)와 오탐 방지용 허용 단어(`ALLOWED`). 앞뒤 공백을 지우고, 같은 종류에 같은 단어는 409 `ADMIN_FORBIDDEN_WORD_DUPLICATE`입니다. 등록한 관리자와 감사 로그가 남습니다.
- 바꾸면 Valkey의 `forbidden-words:version`을 새 무작위 값으로 바꿉니다. 서버마다 가진 금칙어 캐시는 이 버전을 1초에 한 번 확인해 바뀌었으면 다시 읽습니다(바꾼 서버는 즉시, 다른 서버는 1초 안에 반영). 버전을 읽지 못하면 5초 동안 다시 묻지 않고 1분 만료로 갱신합니다.

### 앱 설정

- `GET/PUT /admin/app-config`: 점검 모드(켜기·문구·끝나는 시각), 플랫폼별 최소·최신 버전, 스토어 주소를 통째로 바꿉니다. 버전 형식과 최소 ≤ 최신을 검사합니다(400). 바꾸면 감사 로그에 이전·이후 값이 남고, 서버마다 5초 캐시라 모든 서버에 5초 안에 반영됩니다.
- 점검 중에도 관리자는 모든 API를 쓸 수 있어 점검을 풀 수 있습니다(`GET /app/status`와 로그인도 열려 있음).

### 약관 버전

- `GET /admin/policies`(시행 전 버전 포함)와 `POST /admin/policies`(종류·버전·제목·내용·시행일·재동의 필요 여부). 시행일은 지금 이후만 받습니다. 필수 여부를 비우면 새 버전 바로 앞 버전을 따릅니다. 같은 종류에 같은 버전은 409 `POLICY_VERSION_EXISTS`, 같은 시행일은 409 `POLICY_EFFECTIVE_AT_EXISTS`입니다.
- 시행일이 되면 현재 약관이 되고, 재동의가 필요한 버전이거나 선택 약관이 필수로 바뀐 버전이면 그 뒤 첫 요청부터 약관 동의를 안내합니다(서버마다 약관 캐시 1분). 고지 공지(시행 7일 전, 불리한 변경은 30일 전)는 공지로 따로 등록합니다.

### 오늘의 문장 관리

- 상태: 등록하면 `PENDING_REVIEW`(검수 대기) → 게시 예약하면 `SCHEDULED` → 날짜가 되면 06:00 작업이 `PUBLISHED`로 바꿉니다. 게시 예약할 때 날짜가 이미 오늘(06:00 기준) 이전이면 바로 게시합니다. 게시를 취소하면 검수 대기로 돌아가고 앱에서 사라집니다.
- `POST /admin/morning/parse`: 게시물 본문을 저장하지 않고 분석합니다. 줄마다 `머리말: 내용`이고 칸은 `|`로 나눕니다.

```text
문장: Persistence is the key.
뜻: 꾸준함이 열쇠다.
어휘: persistence | 끈기, 꾸준함 | Her persistence paid off.
퀴즈 빈칸: _____ is the key. | Persistence | 해설(선택)
퀴즈 뜻: key의 뜻은? | 열쇠 / 문 / 창 | 열쇠 | 해설(선택)
```

- `POST /admin/morning`: 날짜당 하나, 있으면 409 `MORNING_DATE_EXISTS`(`replace: true`면 게시 전 문장을 교체, 게시된 날짜는 409 `MORNING_ALREADY_PUBLISHED`). 어휘·퀴즈는 비어 있어도 저장되고, 강조 위치를 비우면 문장에서 처음 나오는 위치로 채웁니다.
- `PATCH /admin/morning/{id}`: 보낸 항목만(어휘·퀴즈는 통째로) 바꿉니다. 예약·게시된 문장은 바꾼 뒤에도 게시할 수 있어야 하고(400), 게시된 문장의 날짜는 바꿀 수 없습니다. 이미 푼 사용자의 기록(정답 수)은 그대로입니다.
- `POST /admin/morning/{id}/publish`: 문장·뜻·어휘·퀴즈가 다 있어야 하고(400 `MORNING_INCOMPLETE`), 빈칸 정답이 문장에 있어야 하며(400 `MORNING_BLANK_NOT_IN_SENTENCE`), 강조 위치·객관식 정답이 맞아야 합니다(400 `MORNING_INVALID`). `detail.issues`에 문제 목록이 담깁니다. 시드도 같은 검사를 씁니다.

### 시즌 관리

- 시즌은 기간이 끝나면 자동으로 마감·확정합니다(관리자 확정 없음). 관리자는 결과를 보고 제외 대상을 정하거나 실패한 마감을 다시 돌립니다.
- `GET /admin/seasons`(주간·월간, 상태 필터, 최근 시즌순): `endDate`는 마지막 날(포함), `closedAt`은 확정 시각입니다. `pendingReportCount`는 그 시즌 학교 순위에 든 사용자(제외된 사용자 포함)가 대상인 처리 전(`RECEIVED`·`IN_REVIEW`) 신고 묶음 수로, 조회할 때 기준입니다. 시즌 기간에 부정 의심 표시가 있는 순위 사용자 수(`suspiciousCount`)와, 상세 순위마다 의심 여부(`suspicious`)도 보여 줍니다.
- `GET /admin/seasons/{seasonId}`: 학교 범위를 마감 순서대로 100위까지(그 사이의 제외된 사용자도 `rank: null`, `excluded: true`로 함께), 제외 대상 전체(사유·관리자·시각), FAILED일 때 실패 사유. 없으면 404 `ADMIN_SEASON_NOT_FOUND`입니다.
- `PUT /admin/seasons/{seasonId}/exclusions`: 제외 대상을 통째로 바꿉니다(최대 100명, 사유 필수, 빈 배열이면 모두 해제). 상태와 관계없이 바꿀 수 있고, 같은 트랜잭션에서 그 시즌의 학교·학년·반 순위를 마감과 같은 규칙으로 다시 매깁니다. 계속 제외되는 사용자는 처음 사유를 그대로 두고, 없는 사용자는 404 `USER_NOT_FOUND`입니다.
- `POST /admin/seasons/{seasonId}/rerun`: `FAILED`만(409 `ADMIN_SEASON_NOT_FAILED`) `ranking` 큐에 `close-season` 작업으로 넣고 202를 돌려줍니다. 진행은 `GET /admin/jobs`의 `SEASON_CLOSE`에서 봅니다. 따라잡는 기간보다 오래된 시즌도 다시 돌릴 수 있지만, 지난 ZSET이 만료됐으면 빈 스냅샷으로 확정됩니다.
- 제외 대상 변경과 다시 실행은 감사 로그에 남습니다.

### 정기 작업

- 정기 작업(정리, 시즌 마감, 챌린지 생성, 예약 알림, 학적 동기화, 부정 감지)은 실행할 때마다 `job_runs`에 시작·끝·상태·오류·실행 방식(정기/수동)을 남기고, 7일 지난 기록은 매일 정리에서 지웁니다. 작업 목록은 `src/modules/jobs/job-registry.ts`입니다.
- 시즌 마감이 실패하거나(한 시즌이라도 확정하지 못하면) 학적 동기화가 실패하면 실패로 남기고 활동 중인 관리자 모두에게 `ADMIN_ALERT`를 보냅니다(실패가 이어지는 동안은 처음 한 번만).
- `GET /admin/jobs`: 작업마다 주기, 마지막 실행·상태·오류, 다음 정기 실행. `POST /admin/jobs/{job}/run`: 큐에 넣고 바로 202를 돌려주고, 실행 중이거나 30초 안에 다시 누르면 409 `ADMIN_JOB_RUNNING`, 정해진 시각에 보내는 알림 작업(리마인더·오늘의 문장 알림·주간 결과·순위 하락)은 409 `ADMIN_JOB_SCHEDULE_ONLY`입니다(1시간 넘게 RUNNING이면 서버가 꺼진 것으로 보고 다시 실행 가능).

### 학적 동기화

매일 04:00(KST, `datagsm-sync` 큐)에 DataGSM OpenAPI `GET /v1/students`(졸업생·자퇴생 포함, 1000명씩 페이지)로 학적을 맞춥니다. `POST /admin/jobs/DATAGSM_SYNC/run`으로 직접 실행할 수도 있습니다.

- 우리 서비스에 가입한 학생만 맞추고 계정은 새로 만들지 않습니다. 교사는 건드리지 않습니다.
- 학생 목록은 계정 ID가 아닌 학생 ID를 주므로 `users.datagsm_student_id`(로그인할 때 저장)로 찾고, 아직 없는 사용자는 이메일로 찾아 학생 ID를 채웁니다(같은 이메일의 계정이 여럿이면 맞추지 않음). 다른 계정에 붙은 학생 ID는 본인이 로그인할 때 가져옵니다.
- 학년·반·번호가 모두 있을 때만 학년·반·번호·학번을 바꿉니다(DataGSM에서 정보 수정 요청 중인 재학생은 비어 있어 그대로 둠, 학번만 비어 있으면 학번은 남김). 이름도 맞춥니다.
- 졸업·자퇴로 나온 활동 중 학생은 휴면(`INACTIVE`)으로 바꾸고 모든 기기에서 로그아웃시킵니다. 마지막 학년·반은 남깁니다. 휴면이던 학생이 재학으로 나오면 다시 `ACTIVE`입니다(로그인과 같은 규칙).
- 목록에서 빠진 학생은 DataGSM 오류일 수 있어 휴면 처리하지 않습니다. 정지된 학생은 학적만 바꾸고 상태는 그대로, 탈퇴한 사용자는 건드리지 않습니다.
- 재학생의 반이 `classes`에 없으면 만듭니다.
- 학년·반이 바뀌면 이번 주·이번 달·전체 랭킹 점수를 옛 학년·반 키에서 새 키로 옮깁니다(학교 키 점수 기준). 동기화 전에 로그인해서 바뀐 경우도 로그인에서 옮깁니다.
- 사용자마다 행을 잠근 트랜잭션으로 바꾸고, 200명씩 나눠 맞춥니다. 결과(`fetched`, `matched`, `updated`, `deactivated`, `reactivated`, `classesCreated`, `skipped`, `failed`)는 `job_runs.result`에 남고, 일부 사용자가 실패하면 같은 건수가 `job_runs.error` 메시지에 담깁니다. `skipped`는 탈퇴한 사용자와 학년·반·번호가 비어 학적을 그대로 둔 학생 수입니다. DataGSM 응답에서 형식이 틀린 학생은 건너뛰고 경고 로그만 남깁니다. 로그인도 학년·반·번호가 다 있을 때만 학적을 바꿉니다.
  - 알려진 한계: 동기화가 학년·반을 옮기는 바로 그 순간에 XP가 더해지면 그 XP가 옛 반 점수에 남을 수 있고(학교 점수는 정확, `pnpm ranking:rebuild`로 복구), 동기화 도중 로그인한 학생은 시작할 때 받은 목록 값으로 다시 덮일 수 있습니다(다음 로그인·동기화 때 바로잡힘). 한 사용자 반영이 실패해도 나머지는 끝까지 반영하고, 실패한 사용자가 있으면 건수를 담아 실패로 남깁니다.
- `DATAGSM_API_KEY`가 없으면 경고 로그만 남기고 성공(`{ disabled: true }`)으로 끝냅니다. DataGSM 요청이 하나라도 실패하면 아무것도 바꾸지 않고 실패로 남깁니다. 실패하면 관리자에게 알립니다.

## 고객지원

### FAQ

- `GET /faqs`: 로그인 없이(점검 중에도) 분류 순, 분류 안에서는 순서대로 보여 줍니다. 분류로 거를 수 있습니다.
- `POST /admin/faqs`, `PATCH/DELETE /admin/faqs/{faqId}`: 순서를 비우면 그 분류의 맨 뒤에 붙습니다. 수정은 보낸 항목만 바꾸고, 바꿀 때마다 감사 로그가 남습니다.

### 공지

- `GET /notices`: 고정 공지 먼저, 그다음 최신순(커서 `(pinned, id)`), 읽음 여부 포함. `GET /notices/{noticeId}`는 열면 읽음 처리하고, 삭제·비공개 공지는 404 `NOTICE_NOT_FOUND`입니다.
- 관리자: `GET /admin/notices`(초안 포함), `POST`(Markdown, 고정·공개 여부, 푸시 선택), `PATCH`, `DELETE`(소프트 삭제). 푸시를 고르면 공개 공지일 때 활동 중인 모든 사용자에게 `NOTICE` 알림을 보냅니다(공지 알림을 끈 사람은 알림 설정에서 걸러짐, 1000명씩 나눠 저장). 바꿀 때마다 감사 로그가 남습니다.

### 1:1 문의

- `POST /inquiries`(multipart/form-data, Idempotency-Key 필수): `type`·`title`(1~50자)·`content`(10~1000자)와 `images` 필드로 이미지 3장까지, 한 장에 5MB까지 받습니다. 앱 버전·플랫폼은 `X-Client-Platform`·`X-Client-Version`에서 저장합니다.
- 이미지는 확장자·Content-Type이 아니라 파일 앞부분의 시그니처로 형식을 판단해 JPEG·PNG·WebP만 받고, sharp로 같은 형식으로 다시 인코딩해 EXIF(위치 정보 포함)를 지웁니다(회전 정보는 픽셀에 먼저 적용). 디코딩 메모리 때문에 2500만 픽셀까지만 받고, 서버마다 한 장씩 차례로 처리합니다. HEIC는 sharp 기본 빌드에 HEVC 디코더가 없어 400 `INQUIRY_IMAGE_INVALID`로 거절하니 앱에서 JPEG로 바꿔 보냅니다. 5MB를 넘으면 400 `INQUIRY_IMAGE_TOO_LARGE`, 4장 이상이거나 필드가 틀리면 400 `INVALID_REQUEST`입니다.
- 한 사람이 첫 문의부터 1시간 동안 5건까지(임시값, Valkey 카운터 `inquiry:rate:{userId}`) 남길 수 있고, 넘으면 429 `INQUIRY_TOO_FREQUENT`(Retry-After)입니다. 검증에 실패한 요청은 세지 않습니다.
- 이미지는 서버 디스크 `UPLOAD_DIR`(기본 `./uploads`) 아래 `inquiries/{imageId}`에 둡니다. 개발 서버는 named volume `uploads`를 `/app/uploads`에 붙입니다. 파일을 먼저 쓰고 DB에 저장하며, 저장에 실패하면 파일을 지우고, 서버가 중간에 멈춰 남은 파일은 정리 작업이 지웁니다.
- `GET /inquiries`(내 문의, 최신순 커서), `GET /inquiries/{inquiryId}`(본인 문의만, 관리자는 모든 문의, 아니면 403 `FORBIDDEN`, 없으면 404 `INQUIRY_NOT_FOUND`). 이미지는 10분 동안 유효한 서명 주소 `/inquiries/images/{imageId}?exp=..&sig=..`로 내줍니다. 서명은 `HMAC-SHA256(imageId.exp)`이고, 키는 `UPLOAD_SIGNING_SECRET`이 없으면 `JWT_PRIVATE_KEY`에서 HMAC으로 유도합니다. 서명이 권한이라 이 주소는 로그인·클라이언트 헤더 없이 `<img src>`로 열리고(웹에서도 보이게 `Cross-Origin-Resource-Policy: cross-origin`), 만료·변조되면 403 `INQUIRY_IMAGE_URL_INVALID`입니다.
- 관리자: `GET /admin/inquiries`(상태·종류 필터, 최신순 페이지, 작성자·플랫폼·앱 버전 포함). 상세는 `GET /inquiries/{inquiryId}`로 봅니다. `POST /admin/inquiries/{inquiryId}/answer`는 답변을 쓰고 상태를 `ANSWERED`로 바꾸며, 다시 호출하면 답변을 고칩니다(`answeredAt`은 마지막으로 쓴 시각). 처음 답할 때만 작성자에게 `INQUIRY_ANSWERED` 알림을 보내고, 쓸 때마다 감사 로그(`INQUIRY_ANSWER`)가 남습니다.

## 정리 작업

BullMQ `maintenance` 큐의 job scheduler로 돌립니다(`src/modules/maintenance`). 스케줄은 Valkey에 저장돼서 인스턴스가 여러 개여도 한 번만 실행되고, 앱을 다시 띄워도 upsert라 중복 등록되지 않습니다.

| 작업                    | 주기 (KST) | 내용                                                                                                                                                                         |
| ----------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `expire-study-sessions` | 매시 5분   | 만료된 `IN_PROGRESS` 학습을 `ABANDONED`로 바꿈                                                                                                                               |
| `daily-cleanup`         | 매일 03:00 | 위 작업에 더해, 끝났거나 버린 지 7일 지난 세션(문항·답안 포함) 삭제, 7일 지난 연습 삭제, 30일 지난 알림 삭제, 삭제된 단어의 즐겨찾기 삭제, 정지 기간이 끝난 탈퇴자 정보 삭제 |

- 학습 기록(`study_records`)은 지우지 않습니다. 사용자가 늘면 보관 기간을 다시 정합니다. 세션을 지워도 기록은 남고 `study_records.session_id`만 NULL이 됩니다.
- 지울 행은 1000개씩 나눠 지워서 테이블을 오래 잠그지 않습니다.
- `daily-cleanup`은 DB에 없는 문의 이미지 파일(파일을 쓴 뒤 DB에 저장하기 전에 서버가 멈춘 경우)도 저장한 지 하루가 지나면 지웁니다. 파일 이름이 이미지 ID 형식이 아니면 건드리지 않습니다.
- 스케줄 등록은 앱 시작을 기다리게 하지 않습니다. Valkey가 내려가 있으면 BullMQ 명령은 연결될 때까지 대기하므로, 기다리면 앱 시작이 멈춥니다.

## 학급·교사 담당 반

- 학급은 마이그레이션으로 1~3학년 1~4반을 미리 만들고, 그 밖의 반은 학생이 로그인할 때와 학적 동기화 때 DataGSM 학년·반으로 자동 생성됩니다.
- 담당 반이 없는 교사는 로그인 `nextStep`이 `TEACHER_CLASS_SELECT`이고, 반을 고르기 전까지 대부분의 API가 403 `TEACHER_CLASS_REQUIRED` (관리자 겸 교사는 제외)
- 반 선택 화면: `GET /classes`로 목록을 받아 `PUT /teachers/me/classes { classIds }`로 저장(전체 교체). 응답의 `nextStep`으로 다음 화면 이동
- 담당 반 변경은 감사 로그(`audit_logs`, `TEACHER_CLASS_CHANGE`)에 남습니다.

### 반 학생 목록·대시보드

- 교사는 담당 반만(403 `CLASS_NOT_ASSIGNED`), 관리자는 학생 관리자도 모든 반을 봅니다. 없는 반은 404 `CLASS_NOT_FOUND`, 담당 반을 고르지 않은 교사는 403 `TEACHER_CLASS_REQUIRED`입니다.
- 반 학생은 그 학년·반의 활동 중·정지 중 학생입니다. 졸업·자퇴(휴면)와 탈퇴한 학생은 빠집니다.
- `GET /classes/{classId}/students`: 번호순으로 이름·학번·번호·마지막 학습일(학습을 끝낸 시각)만 줍니다. 이메일·성별 같은 개인정보는 주지 않습니다.
- `GET /classes/{classId}/dashboard?period=WEEK|MONTH`: 이번 주(월요일부터)·이번 달(1일부터) 오늘까지(KST)를 집계합니다. 랭킹 공개 설정과 관계없이 보여줍니다.
  - 참여율: 기간 안에 학습 답을 하나라도 낸 학생 비율(0~100, 소수 첫째 자리)
  - 학생별 정답률: 4지선다·직접 입력 답만(플래시카드 제외), 관리자 사용자 상세와 같은 기준입니다. 반 평균 정답률은 정답률이 있는 학생들의 정답률 평균입니다(학생마다 같은 비중).
  - 학습 단어 수는 기간 안에 학습한 서로 다른 단어 수, 연속 학습은 지금 이어지고 있는 연속 학습일입니다.
  - 대결 수는 기간 안에 끝난 대결(중도 이탈 포함), 승리 수는 `WIN`만 셉니다(관리자 사용자 상세와 같음).
  - 자주 틀린 단어: 기간 안에 그 단어를 틀린 반 학생 수가 많은 순으로 10개입니다. 오답노트의 마지막으로 틀린 시각으로 판단하므로 학습·대결·오늘의 문장 오답이 모두 들어갑니다.
- 반 학생 수(약 30명) 범위만 묶음 쿼리로 모으므로 집계 테이블·캐시 없이 조회할 때 바로 계산합니다.
