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
pnpm dev
```

`http://localhost:3000/health`가 `{"status":"ok"}`를 돌려주면 정상입니다.

## 명령어

| 명령             | 설명                  |
| ---------------- | --------------------- |
| `pnpm dev`       | 개발 서버 (변경 감지) |
| `pnpm build`     | 빌드 (`dist/`)        |
| `pnpm start`     | 빌드 결과 실행        |
| `pnpm test`      | 테스트                |
| `pnpm typecheck` | 타입 검사             |
| `pnpm lint`      | 린트·포맷 검사        |
| `pnpm format`    | 린트·포맷 자동 수정   |

## 프로젝트 구조

```
src/
  config/    환경 변수 검증
  modules/   도메인별 모듈
test/        통합 테스트
```

## 환경 변수

| 이름       | 기본값        | 설명                                    |
| ---------- | ------------- | --------------------------------------- |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `HOST`     | `0.0.0.0`     | 서버 바인딩 주소                        |
| `PORT`     | `3000`        | 서버 포트                               |

값이 없거나 형식이 틀리면 서버가 시작되지 않습니다.
