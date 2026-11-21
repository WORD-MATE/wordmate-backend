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

| 명령                   | 설명                                                         |
| ---------------------- | ------------------------------------------------------------ |
| `pnpm dev`             | 개발 서버 (변경 감지)                                        |
| `pnpm build`           | 빌드 (`dist/`)                                               |
| `pnpm start`           | 빌드 결과 실행                                               |
| `pnpm test`            | 단위 테스트                                                  |
| `pnpm test:e2e`        | 통합 테스트 (Docker 필요, MySQL·Valkey 컨테이너 자동 실행)   |
| `pnpm typecheck`       | 타입 검사                                                    |
| `pnpm lint`            | 린트·포맷 검사                                               |
| `pnpm format`          | 린트·포맷 자동 수정                                          |
| `pnpm db:generate`     | 스키마 변경으로 마이그레이션 생성 (`drizzle/`)               |
| `pnpm db:migrate`      | 마이그레이션 적용                                            |
| `pnpm db:seed <파일>`  | 기본 단어팩 시드 반영 (아래 "기본 단어팩 시드" 참고)         |
| `pnpm ranking:rebuild` | XP 원장에서 이번 주·이번 달·전체 랭킹 재구성 (Valkey 복구용) |
| `pnpm db:studio`       | Drizzle Studio (DB 브라우저)                                 |
| `pnpm jwt:keygen`      | JWT 서명용 Ed25519 키 생성                                   |

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
| `VALKEY_URL`            | (필수)                                   | `redis://host:6379`                                                 |
| `JWT_PRIVATE_KEY`       | (필수)                                   | Ed25519 개인키 PEM (`pnpm jwt:keygen`으로 생성)                     |
| `JWT_KEY_ID`            | `k1`                                     | 토큰 헤더의 kid (키 교체 시 변경)                                   |
| `DATAGSM_CLIENT_ID`     | (필수)                                   | DataGSM OAuth 클라이언트 ID                                         |
| `DATAGSM_REDIRECT_URIS` | (필수)                                   | 허용할 redirectUri, 쉼표로 구분 (DataGSM에 등록한 값과 같아야 함)   |
| `DATAGSM_AUTH_URL`      | `https://oauth.authorization.datagsm.kr` | DataGSM 인증 서버                                                   |
| `DATAGSM_RESOURCE_URL`  | `https://oauth.resource.datagsm.kr`      | DataGSM 사용자 정보 서버                                            |
| `TRUST_PROXY`           | (없음)                                   | 신뢰할 리버스 프록시 IP·CIDR, 쉼표로 구분 (실제 클라이언트 IP 판별) |
| `SWAGGER_ENABLED`       | `production`이 아니면 켜짐               | `true` / `false`로 Swagger 문서 강제 설정                           |
| `SHARE_LINK_BASE`       | `wordmate://`                            | 공유 링크 앞부분. 웹 도메인이 생기면 `https://도메인`으로 바꿈      |

값이 없거나 형식이 틀리면 서버가 시작되지 않습니다.

## 점검 모드·강제 업데이트

Valkey의 `app:config` 키(JSON)로 설정하며 서버는 5초마다 다시 읽습니다. 관리자 API가 생기기 전까지는 직접 설정합니다.

```bash
valkey-cli SET app:config '{"maintenance":{"enabled":true,"message":"정기 점검","endsAt":"2026-12-01T00:00:00.000Z"},"minVersion":{"IOS":"1.2.0"},"latestVersion":{"IOS":"1.5.0"},"storeUrl":{"IOS":"https://apps.apple.com/..."}}'
```

- 점검 중: 503 `MAINTENANCE` (`detail`: `message`, `endsAt`)
- 최소 버전 미만: 426 `UPDATE_REQUIRED` (`detail.storeUrl`, 웹은 `null`)
- `GET /app/status`는 점검 중에도 200으로 점검 정보와 업데이트 상태(`REQUIRED` / `RECOMMENDED` / `NONE`)를 돌려줍니다.

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
2. 서버에서 `deploy/dev/setup-server.sh`를 실행합니다 (Docker 설치, swap 2GB, `~/wordmate` 생성). 끝나면 다시 로그인합니다.
3. `~/wordmate/.env`를 만듭니다.

```bash
MYSQL_PASSWORD=          # openssl rand -hex 24
MYSQL_ROOT_PASSWORD=     # openssl rand -hex 24
JWT_PRIVATE_KEY=         # openssl genpkey -algorithm ed25519 | awk '{printf "%s\\n", $0}'
DATAGSM_CLIENT_ID=
DATAGSM_REDIRECT_URIS=
CORS_ORIGINS=
SWAGGER_ENABLED=true
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
- `PATCH /users/me/privacy`(학생만)는 공개 설정과 함께 `ranking_onboarded`를 true로 바꿉니다. 랭킹 첫 진입 안내와 설정 화면이 같이 씁니다. ZSET은 건드리지 않습니다.
- `GET /users/me/xp-history`(학생만)는 XP 원장을 최신순으로 보여줍니다. 하루 상한에 걸려 0이 된 지급도 `blockedReason`과 함께 보여주고, 관리자 조정은 음수입니다.
- Valkey가 날아가면 `pnpm ranking:rebuild`(서버는 `docker compose run --rm migrate dist/ranking-rebuild.js`)로 원장에서 다시 만듭니다. 학년·반은 지금 값으로 넣습니다.

## 홈

- `GET /home`은 복습 수, 이어할 학습, 스트릭, 이번 주 학교 순위, 추천 단어팩을 한 번에 내려주는 묶음 API입니다. 각 칸은 기존 서비스(`StudySessionsService`, `RecordsService`, `RankingQueryService`, `PacksService`)를 병렬로 부릅니다.
- 한 칸이 실패해도 나머지는 내려주고, 실패한 칸은 null(추천 팩은 빈 배열)로 두고 로그를 남깁니다.
- 이어할 학습이 팩 학습이 아니면 `packName`에 학습 종류 이름(즐겨찾기·오답노트·틀린 단어·오늘의 복습)을 넣습니다.
- 추천 단어팩은 학습 기록이 하나도 없는 사용자에게만 기본 단어팩 추천순 5개를 줍니다. 교사는 주간 순위가 null입니다.
- 오늘의 문장(`morning`)과 미션(`missions`)은 기능이 생기기 전까지 null입니다.

## 정리 작업

BullMQ `maintenance` 큐의 job scheduler로 돌립니다(`src/modules/maintenance`). 스케줄은 Valkey에 저장돼서 인스턴스가 여러 개여도 한 번만 실행되고, 앱을 다시 띄워도 upsert라 중복 등록되지 않습니다.

| 작업                    | 주기 (KST) | 내용                                                                                             |
| ----------------------- | ---------- | ------------------------------------------------------------------------------------------------ |
| `expire-study-sessions` | 매시 5분   | 만료된 `IN_PROGRESS` 학습을 `ABANDONED`로 바꿈                                                   |
| `daily-cleanup`         | 매일 03:00 | 위 작업에 더해, 끝났거나 버린 지 7일 지난 세션(문항·답안 포함) 삭제, 삭제된 단어의 즐겨찾기 삭제 |

- 학습 기록(`study_records`)은 지우지 않습니다. 사용자가 늘면 보관 기간을 다시 정합니다. 세션을 지워도 기록은 남고 `study_records.session_id`만 NULL이 됩니다.
- 지울 행은 1000개씩 나눠 지워서 테이블을 오래 잠그지 않습니다.
- 스케줄 등록은 앱 시작을 기다리게 하지 않습니다. Valkey가 내려가 있으면 BullMQ 명령은 연결될 때까지 대기하므로, 기다리면 앱 시작이 멈춥니다.

## 학급·교사 담당 반

- 학급은 마이그레이션으로 1~3학년 1~4반을 미리 만들고, 그 밖의 반은 학생이 로그인할 때 DataGSM 학년·반으로 자동 생성됩니다.
- 담당 반이 없는 교사는 로그인 `nextStep`이 `TEACHER_CLASS_SELECT`이고, 반을 고르기 전까지 대부분의 API가 403 `TEACHER_CLASS_REQUIRED` (관리자 겸 교사는 제외)
- 반 선택 화면: `GET /classes`로 목록을 받아 `PUT /teachers/me/classes { classIds }`로 저장(전체 교체). 응답의 `nextStep`으로 다음 화면 이동
- 담당 반 변경은 감사 로그(`audit_logs`, `TEACHER_CLASS_CHANGE`)에 남습니다.
