import { drizzle } from 'drizzle-orm/mysql2';
import { Redis } from 'ioredis';
import { createPool } from 'mysql2/promise';
import { z } from 'zod';
import { loadEnvFiles } from './config/env.js';
import { RankingService } from './modules/ranking/ranking.service.js';

// XP 원장에서 이번 주·이번 달·전체 랭킹을 다시 만든다 (Valkey 데이터 유실 복구용)
loadEnvFiles();
const env = z
  .object({ DATABASE_URL: z.url({ protocol: /^mysql$/ }), VALKEY_URL: z.url() })
  .parse(process.env);

const pool = createPool({ uri: env.DATABASE_URL, connectionLimit: 1, timezone: 'Z' });
const valkey = new Redis(env.VALKEY_URL, { maxRetriesPerRequest: 1 });
try {
  const counts = await new RankingService(drizzle({ client: pool }), valkey).rebuild();
  console.log('랭킹 재구성 완료 (기간별 사용자 수)', JSON.stringify(counts));
} finally {
  await pool.end();
  valkey.disconnect();
}
