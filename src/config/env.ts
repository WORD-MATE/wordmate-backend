import { existsSync } from 'node:fs';
import { z } from 'zod';

const commaList = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    )
    .pipe(z.array(item));

/** 한 줄로 넣은 PEM(\n)을 줄바꿈으로 */
const pem = z
  .string()
  .min(1)
  .transform((value) => value.replaceAll(String.raw`\n`, '\n'));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: commaList(z.url()),
  TRUST_PROXY: commaList(z.union([z.cidrv4(), z.ipv4()])),
  // /metrics 전용 내부 포트. compose에서 공개하지 않아 같은 도커 네트워크에서만 닿는다. 0이면 끈다
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
  SWAGGER_ENABLED: z.stringbool().optional(),
  DATABASE_URL: z.url({ protocol: /^mysql$/ }),
  // 대결 참가·매칭이 몰릴 때 연결을 기다리지 않도록 넉넉히 (MySQL max_connections 151보다 작게)
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  VALKEY_URL: z.url({ protocol: /^rediss?$/ }),
  JWT_PRIVATE_KEY: pem,
  JWT_KEY_ID: z.string().min(1).default('k1'),
  DATAGSM_CLIENT_ID: z.string().min(1),
  DATAGSM_REDIRECT_URIS: commaList(z.url()).refine(
    (uris) => uris.length > 0,
    '1개 이상 필요합니다.',
  ),
  DATAGSM_AUTH_URL: z.url().default('https://oauth.authorization.datagsm.kr'),
  DATAGSM_RESOURCE_URL: z.url().default('https://oauth.resource.datagsm.kr'),
  DATAGSM_OPENAPI_URL: z.url().default('https://openapi.datagsm.kr'),
  // 학적 동기화용 OpenAPI 키 (student:read). 없으면 동기화를 건너뛴다
  DATAGSM_API_KEY: z.string().min(1).optional(),
  // 웹 도메인이 생기기 전까지는 앱 스킴으로 공유 링크를 만든다
  SHARE_LINK_BASE: z.url().default('wordmate://'),
  UPLOAD_DIR: z.string().min(1).default('./uploads'),
  // 없으면 JWT_PRIVATE_KEY에서 유도한다. 바꾸면 이미 내준 이미지 주소는 무효가 된다
  UPLOAD_SIGNING_SECRET: z.string().min(32).optional(),
  // 푸시 키. 없으면 그 플랫폼은 보내지 않고 기록만 남긴다
  APNS_KEY_P8: pem.optional(),
  APNS_KEY_ID: z.string().min(1).optional(),
  APNS_TEAM_ID: z.string().min(1).optional(),
  APNS_BUNDLE_ID: z.string().min(1).optional(),
  APNS_SANDBOX: z.stringbool().default(false),
  FCM_PROJECT_ID: z.string().min(1).optional(),
  FCM_CLIENT_EMAIL: z.email().optional(),
  FCM_PRIVATE_KEY: pem.optional(),
  VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  VAPID_SUBJECT: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`환경 변수 검증 실패:\n${issues}`);
  }
  return result.data;
}

export function loadEnvFiles(): void {
  for (const file of ['.env.local', '.env']) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}
