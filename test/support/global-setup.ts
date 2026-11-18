import { startTestInfra } from './infra.js';

export default async function setup(): Promise<() => Promise<void>> {
  const infra = await startTestInfra();
  process.env.DATABASE_URL = infra.databaseUrl;
  process.env.VALKEY_URL = infra.valkeyUrl;
  return infra.stop;
}
