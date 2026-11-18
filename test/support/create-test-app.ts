import type { ModuleMetadata } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { createFastifyAdapter, setupApp } from '../../src/app.setup.js';

export const TEST_CORS_ORIGIN = 'http://localhost:5173';

export async function createTestApp(
  extra: ModuleMetadata = {},
  beforeInit?: (app: NestFastifyApplication) => void,
): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    ...extra,
    imports: [AppModule, ...(extra.imports ?? [])],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    createFastifyAdapter({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
  );
  await setupApp(app, { swagger: true, corsOrigins: [TEST_CORS_ORIGIN] });
  beforeInit?.(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
