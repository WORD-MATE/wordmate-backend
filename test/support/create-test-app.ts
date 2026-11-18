import type { ModuleMetadata } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { createFastifyAdapter, setupApp } from '../../src/app.setup.js';

export async function createTestApp(extra: ModuleMetadata = {}): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    ...extra,
    imports: [AppModule, ...(extra.imports ?? [])],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter());
  setupApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
