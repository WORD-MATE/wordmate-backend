import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppConfigService } from '../src/common/app-config/app-config.service.js';
import { createTestApp } from './support/create-test-app.js';

describe('AppConfigService (Valkey)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('저장한 설정을 기본값을 채워 읽는다', async () => {
    const service = app.get(AppConfigService);
    await service.set({ minVersion: { ANDROID: '3.1.0' } });

    expect(await service.get()).toEqual({
      maintenance: { enabled: false, message: '', endsAt: null },
      minVersion: { ANDROID: '3.1.0' },
      storeUrl: {},
    });
  });
});
