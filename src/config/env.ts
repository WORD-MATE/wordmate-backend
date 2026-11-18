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

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  CORS_ORIGINS: commaList(z.url()),
  DATABASE_URL: z.url({ protocol: /^mysql$/ }),
  VALKEY_URL: z.url({ protocol: /^rediss?$/ }),
  DATAGSM_CLIENT_ID: z.string().min(1),
  DATAGSM_REDIRECT_URIS: commaList(z.url()).refine(
    (uris) => uris.length > 0,
    '1개 이상 필요합니다.',
  ),
  DATAGSM_AUTH_URL: z.url().default('https://oauth.authorization.datagsm.kr'),
  DATAGSM_RESOURCE_URL: z.url().default('https://oauth.resource.datagsm.kr'),
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
