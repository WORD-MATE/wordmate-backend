import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import { createConnection } from 'mysql2/promise';
import { z } from 'zod';
import { loadEnvFiles } from './config/env.js';

loadEnvFiles();
const databaseUrl = z.url({ protocol: /^mysql$/ }).parse(process.env.DATABASE_URL);

const connection = await createConnection({ uri: databaseUrl });
try {
  await migrate(drizzle({ client: connection }), { migrationsFolder: './drizzle' });
  console.log('마이그레이션 완료');
} finally {
  await connection.end();
}
