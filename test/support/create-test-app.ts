import type { ModuleMetadata } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { InjectOptions } from 'fastify';
import { AppModule } from '../../src/app.module.js';
import { createFastifyAdapter, setupApp } from '../../src/app.setup.js';

export const TEST_CORS_ORIGIN = 'http://localhost:5173';

export const CLIENT_HEADERS = { 'x-client-platform': 'IOS', 'x-client-version': '1.0.0' };

export interface TestAppOptions extends ModuleMetadata {
  overrides?: Array<[token: unknown, value: unknown]>;
  beforeInit?: (app: NestFastifyApplication) => void;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<NestFastifyApplication> {
  const { overrides = [], beforeInit, ...metadata } = options;
  let builder = Test.createTestingModule({
    ...metadata,
    imports: [AppModule, ...(metadata.imports ?? [])],
  });
  for (const [token, value] of overrides) {
    builder = builder.overrideProvider(token).useValue(value);
  }
  const app = (await builder.compile()).createNestApplication<NestFastifyApplication>(
    createFastifyAdapter({ NODE_ENV: 'test', LOG_LEVEL: 'silent' }),
  );
  await setupApp(app, { swagger: true, corsOrigins: [TEST_CORS_ORIGIN] });
  beforeInit?.(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

/** 클라이언트 필수 헤더를 붙여 요청한다. */
export function inject(app: NestFastifyApplication, options: InjectOptions) {
  return app.inject({ ...options, headers: { ...CLIENT_HEADERS, ...options.headers } });
}
