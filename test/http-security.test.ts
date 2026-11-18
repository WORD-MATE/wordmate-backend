import { Body, Controller, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/common/auth/auth.decorator.js';
import { createTestApp, inject, TEST_CORS_ORIGIN } from './support/create-test-app.js';

@Auth('ALL')
@Controller('test-http')
class HttpTestController {
  @Post('echo')
  echo(@Body() body: unknown) {
    return body;
  }
}

describe('HTTP 보안 기본값', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp({ controllers: [HttpTestController] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('helmet 보안 헤더를 붙인다', async () => {
    const res = await inject(app, { url: '/health' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('허용한 Origin에만 CORS를 열고 클라이언트 헤더를 허용한다', async () => {
    const allowed = await inject(app, {
      method: 'OPTIONS',
      url: '/test-http/echo',
      headers: {
        origin: TEST_CORS_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'x-client-platform,idempotency-key',
      },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe(TEST_CORS_ORIGIN);
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(String(allowed.headers['access-control-allow-headers'])).toContain('X-Client-Platform');

    const denied = await inject(app, {
      method: 'OPTIONS',
      url: '/test-http/echo',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('1MB를 넘는 본문은 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await inject(app, {
      method: 'POST',
      url: '/test-http/echo',
      payload: { text: 'a'.repeat(1024 * 1024) },
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().code).toBe('PAYLOAD_TOO_LARGE');
  });
});
