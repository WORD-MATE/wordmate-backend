import { chmod, writeFile } from 'node:fs/promises';
import type { ConfigService } from '@nestjs/config';
import { drizzle } from 'drizzle-orm/mysql2';
import { Redis } from 'ioredis';
import { createPool } from 'mysql2/promise';
import { z } from 'zod';
import { AccessTokenService } from './common/auth/access-token.service.js';
import { type Env, loadEnvFiles } from './config/env.js';
import {
  cleanupLoadUsers,
  createLoadUsers,
  issueLoadTokens,
  MAX_LOAD_USERS,
} from './load-test/load-users.js';

/*
 * 부하 테스트용 학생 계정 (개발 서버 전용). datagsm_id가 loadtest:로 시작하는 계정만 다룬다.
 * 개발 서버 compose에만 있는 LOAD_TEST_ALLOWED=true와 --confirm-dev가 둘 다 있어야 돈다.
 *   node dist/load-users.js create <수> <토큰 파일> --confirm-dev   계정 만들기(약관 동의 포함) + 토큰 발급
 *   node dist/load-users.js tokens <토큰 파일> --confirm-dev       토큰만 다시 발급 (토큰은 30분 유효)
 *   node dist/load-users.js cleanup --confirm-dev                  계정과 대결·XP·랭킹 기록 지우기
 * 토큰은 화면에 출력하지 않고 소유자만 읽을 수 있는 파일로 저장한다.
 */
loadEnvFiles();
const args = process.argv.slice(2);
const [command, ...rest] = args.filter((arg) => !arg.startsWith('--'));
// 개발 서버 compose에만 LOAD_TEST_ALLOWED=true가 있다. 상용 서버에서 잘못 실행해도 계정을 만들거나 지우지 않게 한다
if (process.env.LOAD_TEST_ALLOWED !== 'true' || !args.includes('--confirm-dev')) {
  console.error(
    '개발 서버(LOAD_TEST_ALLOWED=true)에서만 쓰는 명령입니다. 확인했으면 --confirm-dev 를 붙이세요.',
  );
  process.exit(1);
}
const usage = (): never => {
  console.error(
    '사용법: node dist/load-users.js create <수> <토큰 파일> | tokens <토큰 파일> | cleanup (--confirm-dev)',
  );
  process.exit(1);
};

const env = z
  .object({
    DATABASE_URL: z.url({ protocol: /^mysql$/ }),
    VALKEY_URL: z.url(),
    JWT_PRIVATE_KEY: z
      .string()
      .min(1)
      .transform((pem) => pem.replaceAll(String.raw`\n`, '\n')),
    JWT_KEY_ID: z.string().min(1).default('k1'),
  })
  .parse(process.env);
console.log(`대상 DB 호스트: ${new URL(env.DATABASE_URL).hostname}`);

const pool = createPool({ uri: env.DATABASE_URL, connectionLimit: 2, timezone: 'Z' });
const db = drizzle({ client: pool });

async function saveTokens(file: string): Promise<void> {
  const config = { get: (key: keyof typeof env) => env[key] } as unknown as ConfigService<
    Env,
    true
  >;
  const tokens = await issueLoadTokens(db, new AccessTokenService(config));
  await writeFile(file, JSON.stringify(tokens), { mode: 0o600 });
  await chmod(file, 0o600);
  console.log(`토큰 ${tokens.length}개를 ${file}에 저장했습니다 (30분 유효)`);
}

try {
  if (command === 'create') {
    const count = z.coerce.number().int().min(2).max(MAX_LOAD_USERS).safeParse(rest[0]);
    const file = rest[1];
    if (!count.success || !file) usage();
    const created = await createLoadUsers(db, count.data as number);
    console.log(`계정 ${created.users}개 준비, 약관 ${created.policies}개 동의`);
    await saveTokens(file as string);
  } else if (command === 'tokens') {
    if (!rest[0]) usage();
    await saveTokens(rest[0] as string);
  } else if (command === 'cleanup') {
    const valkey = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: 1 });
    try {
      console.log(`계정 ${await cleanupLoadUsers(db, valkey)}개와 기록을 지웠습니다.`);
    } finally {
      valkey.disconnect();
    }
  } else {
    usage();
  }
} finally {
  await pool.end();
}
