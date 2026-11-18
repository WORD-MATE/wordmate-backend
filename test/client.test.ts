import { Controller, Get } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AppConfig, AppConfigService } from '../src/common/app-config/app-config.service.js';
import { Auth } from '../src/common/auth/auth.decorator.js';
import { AllowDuringMaintenance } from '../src/common/client/client.decorators.js';
import { createTestApp, inject } from './support/create-test-app.js';

@Auth('ALL')
@Controller('test-client')
class ClientTestController {
  @Get()
  normal() {
    return { ok: true };
  }

  @AllowDuringMaintenance()
  @Get('status')
  status() {
    return { ok: true };
  }
}

const base: AppConfig = {
  maintenance: { enabled: false, message: '', endsAt: null },
  minVersion: {},
  latestVersion: {},
  storeUrl: {},
};

describe('클라이언트 헤더·점검·강제 업데이트', () => {
  let app: NestFastifyApplication;
  let config: AppConfig = base;

  beforeAll(async () => {
    app = await createTestApp({
      controllers: [ClientTestController],
      overrides: [[AppConfigService, { get: async () => config }]],
    });
  });

  beforeEach(() => {
    config = base;
  });

  afterAll(async () => {
    await app.close();
  });

  it('X-Client-Platform이 없거나 틀리면 400', async () => {
    const missing = await app.inject({ url: '/test-client' });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({
      code: 'INVALID_REQUEST',
      detail: { header: 'X-Client-Platform' },
    });

    const wrong = await inject(app, {
      url: '/test-client',
      headers: { 'x-client-platform': 'PC' },
    });
    expect(wrong.statusCode).toBe(400);
  });

  it('X-Client-Version 형식이 틀리면 400', async () => {
    const res = await inject(app, { url: '/test-client', headers: { 'x-client-version': 'v1' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toEqual({ header: 'X-Client-Version' });
  });

  it('헤더가 맞으면 통과한다', async () => {
    expect((await inject(app, { url: '/test-client' })).statusCode).toBe(200);
  });

  it('점검 중이면 503 MAINTENANCE, 허용된 엔드포인트는 통과', async () => {
    config = {
      ...base,
      maintenance: { enabled: true, message: '정기 점검', endsAt: '2026-11-20T00:00:00.000Z' },
    };

    const res = await inject(app, { url: '/test-client' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({
      code: 'MAINTENANCE',
      detail: { message: '정기 점검', endsAt: '2026-11-20T00:00:00.000Z' },
    });

    expect((await inject(app, { url: '/test-client/status' })).statusCode).toBe(200);
  });

  it('최소 버전보다 낮으면 426 UPDATE_REQUIRED와 스토어 주소', async () => {
    config = {
      ...base,
      minVersion: { IOS: '1.2.0', WEB: '2.0.0' },
      storeUrl: { IOS: 'https://apps.apple.com/app/id0' },
    };

    const old = await inject(app, {
      url: '/test-client',
      headers: { 'x-client-version': '1.1.9' },
    });
    expect(old.statusCode).toBe(426);
    expect(old.json()).toMatchObject({
      code: 'UPDATE_REQUIRED',
      detail: { storeUrl: 'https://apps.apple.com/app/id0' },
    });

    const web = await inject(app, {
      url: '/test-client',
      headers: { 'x-client-platform': 'WEB', 'x-client-version': '1.0.0' },
    });
    expect(web.statusCode).toBe(426);
    expect(web.json().detail).toEqual({ storeUrl: null });

    const current = await inject(app, {
      url: '/test-client',
      headers: { 'x-client-version': '1.2.0' },
    });
    expect(current.statusCode).toBe(200);
  });
});
