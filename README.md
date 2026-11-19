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

| 명령               | 설명                                                       |
| ------------------ | ---------------------------------------------------------- |
| `pnpm dev`         | 개발 서버 (변경 감지)                                      |
| `pnpm build`       | 빌드 (`dist/`)                                             |
| `pnpm start`       | 빌드 결과 실행                                             |
| `pnpm test`        | 단위 테스트                                                |
| `pnpm test:e2e`    | 통합 테스트 (Docker 필요, MySQL·Valkey 컨테이너 자동 실행) |
| `pnpm typecheck`   | 타입 검사                                                  |
| `pnpm lint`        | 린트·포맷 검사                                             |
| `pnpm format`      | 린트·포맷 자동 수정                                        |
| `pnpm db:generate` | 스키마 변경으로 마이그레이션 생성 (`drizzle/`)             |
| `pnpm db:migrate`  | 마이그레이션 적용                                          |
| `pnpm db:studio`   | Drizzle Studio (DB 브라우저)                               |
| `pnpm jwt:keygen`  | JWT 서명용 Ed25519 키 생성                                 |

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
- **요청 제한**: 엔드포인트별 1분 120회 (`@Throttle`로 조정), 초과 시 429 + `Retry-After`

### 데코레이터

| 데코레이터                                        | 용도                                |
| ------------------------------------------------- | ----------------------------------- |
| `@Auth(...)`                                      | 접근 권한                           |
| `@ZodBody` `@ZodQuery` `@ZodParam` `@ZodResponse` | 요청 검증·응답 정리·Swagger 문서    |
| `@Idempotent()`                                   | Idempotency-Key 재전송 처리         |
| `@AllowDuringMaintenance()`                       | 점검 중에도 허용                    |
| `@SkipClientCheck()`                              | 헤더·버전·점검 검사 생략 (인프라용) |
| `@Throttle()` `@SkipThrottle()`                   | 요청 제한 조정                      |

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

| 이름                    | 기본값                                   | 설명                                                               |
| ----------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `NODE_ENV`              | `development`                            | `development` / `test` / `production`                              |
| `HOST`                  | `0.0.0.0`                                | 서버 바인딩 주소                                                   |
| `PORT`                  | `3000`                                   | 서버 포트                                                          |
| `LOG_LEVEL`             | `info`                                   | `fatal` / `error` / `warn` / `info` / `debug` / `trace` / `silent` |
| `CORS_ORIGINS`          | (없음)                                   | 허용할 웹 Origin, 쉼표로 구분                                      |
| `DATABASE_URL`          | (필수)                                   | `mysql://user:pass@host:3306/db`                                   |
| `VALKEY_URL`            | (필수)                                   | `redis://host:6379`                                                |
| `JWT_PRIVATE_KEY`       | (필수)                                   | Ed25519 개인키 PEM (`pnpm jwt:keygen`으로 생성)                    |
| `JWT_KEY_ID`            | `k1`                                     | 토큰 헤더의 kid (키 교체 시 변경)                                  |
| `DATAGSM_CLIENT_ID`     | (필수)                                   | DataGSM OAuth 클라이언트 ID                                        |
| `DATAGSM_REDIRECT_URIS` | (필수)                                   | 허용할 redirectUri, 쉼표로 구분 (DataGSM에 등록한 값과 같아야 함)  |
| `DATAGSM_AUTH_URL`      | `https://oauth.authorization.datagsm.kr` | DataGSM 인증 서버                                                  |
| `DATAGSM_RESOURCE_URL`  | `https://oauth.resource.datagsm.kr`      | DataGSM 사용자 정보 서버                                           |

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

## 인증

1. 클라이언트가 PKCE로 DataGSM 로그인 → 인가 코드 수신
2. `POST /auth/datagsm { code, codeVerifier, redirectUri }` → 액세스 토큰(30분)·리프레시 토큰(30일)·`nextStep`·`user`
3. API 호출: 앱은 `Authorization: Bearer {accessToken}`, 웹은 쿠키(`__Host-at`) 자동 전송
4. `AUTH_TOKEN_EXPIRED`(401)이면 `POST /auth/refresh` 1회 후 재시도. 리프레시 토큰은 매번 새로 바뀜
5. `POST /auth/logout`: 리프레시 토큰만 있으면 됨 (앱은 본문 `refreshToken`, 웹은 쿠키)

웹은 토큰을 응답 본문 대신 HttpOnly 쿠키로 받습니다.

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
