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
cp .env.example .env.local
docker compose up -d
pnpm db:migrate
pnpm dev
```

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

- **에러 응답**: `{ "code": String, "message": String, "detail": Object | null, "traceId": String }`
- **ID**: UUIDv7 문자열 / **시간**: ISO-8601 UTC / **날짜**: KST `YYYY-MM-DD`
- **목록**: 커서 페이지네이션 `?cursor=&size=` (기본 20, 최대 50) → `{ items, nextCursor }`
- **권한**: 엔드포인트마다 `@Auth('ALL' | 'USER' | 'STUDENT' | 'TEACHER' | 'ADMIN')`, 생략하면 `USER`

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

| 이름           | 기본값        | 설명                                    |
| -------------- | ------------- | --------------------------------------- |
| `NODE_ENV`     | `development` | `development` \| `test` \| `production` |
| `HOST`         | `0.0.0.0`     | 서버 바인딩 주소                        |
| `PORT`         | `3000`        | 서버 포트                               |
| `DATABASE_URL` | (필수)        | `mysql://user:pass@host:3306/db`        |
| `VALKEY_URL`   | (필수)        | `redis://host:6379`                     |

값이 없거나 형식이 틀리면 서버가 시작되지 않습니다.
