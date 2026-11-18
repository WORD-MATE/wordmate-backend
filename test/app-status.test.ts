import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AppConfig, AppConfigService } from '../src/common/app-config/app-config.service.js';
import { createTestApp } from './support/create-test-app.js';

const base: AppConfig = {
  maintenance: { enabled: false, message: '', endsAt: null },
  minVersion: { IOS: '1.2.0' },
  latestVersion: { IOS: '1.5.0' },
  storeUrl: { IOS: 'https://apps.apple.com/app/id0' },
};

describe('GET /app/status', () => {
  let app: NestFastifyApplication;
  let config: AppConfig = base;

  const status = (query: string) => app.inject({ url: `/app/status?${query}` });

  beforeAll(async () => {
    app = await createTestApp({ overrides: [[AppConfigService, { get: async () => config }]] });
  });

  beforeEach(() => {
    config = base;
  });

  afterAll(async () => {
    await app.close();
  });

  it('버전에 따라 REQUIRED / RECOMMENDED / NONE (클라이언트 헤더 없이 호출)', async () => {
    const required = await status('platform=IOS&version=1.1.9');
    expect(required.statusCode).toBe(200);
    expect(required.json()).toMatchObject({
      maintenance: { active: false, message: null, endsAt: null },
      update: {
        status: 'REQUIRED',
        minVersion: '1.2.0',
        latestVersion: '1.5.0',
        storeUrl: 'https://apps.apple.com/app/id0',
      },
      serverTime: expect.any(String),
    });
    expect((await status('platform=IOS&version=1.4.0')).json().update.status).toBe('RECOMMENDED');
    expect((await status('platform=IOS&version=1.5.0')).json().update.status).toBe('NONE');
  });

  it('설정이 없는 플랫폼은 NONE, 웹은 스토어 주소가 null', async () => {
    expect((await status('platform=WEB&version=0.1.0')).json().update).toEqual({
      status: 'NONE',
      minVersion: null,
      latestVersion: null,
      storeUrl: null,
    });
  });

  it('점검 중에도 200과 점검 정보를 돌려준다', async () => {
    config = {
      ...base,
      maintenance: { enabled: true, message: '정기 점검', endsAt: '2026-12-01T00:00:00.000Z' },
    };
    const res = await status('platform=ANDROID&version=1.0.0');
    expect(res.statusCode).toBe(200);
    expect(res.json().maintenance).toEqual({
      active: true,
      message: '정기 점검',
      endsAt: '2026-12-01T00:00:00.000Z',
    });
  });

  it('platform·version 형식이 틀리면 400', async () => {
    expect((await status('platform=PC&version=1.0.0')).statusCode).toBe(400);
    expect((await status('platform=IOS&version=v1')).statusCode).toBe(400);
  });
});
