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
