import { readFile } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/mysql2';
import { createPool } from 'mysql2/promise';
import { z } from 'zod';
import { loadEnvFiles } from './config/env.js';
import { applyDefaultPackSeed, DefaultPackSeed } from './modules/packs/seed/default-pack-seed.js';

// 사용법: node dist/seed.js <시드 JSON 파일> [--prune] [--dry-run]
loadEnvFiles();
const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--'));
if (!file) {
  console.error('사용법: node dist/seed.js <시드 JSON 파일> [--prune] [--dry-run]');
  process.exit(1);
}

let json: unknown;
try {
  json = JSON.parse(await readFile(file, 'utf8'));
} catch (error) {
  console.error(
    `시드 파일을 읽을 수 없습니다: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
const parsed = DefaultPackSeed.safeParse(json);
if (!parsed.success) {
  console.error('시드 파일이 올바르지 않습니다.');
  console.error(z.prettifyError(parsed.error));
  process.exit(1);
}
const seed = parsed.data;
const wordTotal = seed.packs.reduce((total, pack) => total + pack.words.length, 0);
console.log(
  `분류 ${seed.categories.length}개, 단어팩 ${seed.packs.length}개, 단어 ${wordTotal}개 확인`,
);
if (args.includes('--dry-run')) process.exit(0);

const databaseUrl = z.url({ protocol: /^mysql$/ }).parse(process.env.DATABASE_URL);
const pool = createPool({ uri: databaseUrl, connectionLimit: 1, timezone: 'Z' });
try {
  const summary = await applyDefaultPackSeed(drizzle({ client: pool }), seed, {
    prune: args.includes('--prune'),
  });
  console.log('시드 반영 완료', JSON.stringify(summary));
} finally {
  await pool.end();
}
