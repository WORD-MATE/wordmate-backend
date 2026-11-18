import { defineConfig } from 'drizzle-kit';
import { loadEnvFiles } from './src/config/env.js';

loadEnvFiles();

export default defineConfig({
  dialect: 'mysql',
  schema: './src/infra/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
});
