import { existsSync } from 'node:fs';
import { defineConfig } from 'drizzle-kit';

for (const file of ['.env.local', '.env']) {
  if (existsSync(file)) process.loadEnvFile(file);
}

export default defineConfig({
  dialect: 'mysql',
  schema: './src/infra/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
