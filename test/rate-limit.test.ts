import { Controller, Get } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Throttle } from '@nestjs/throttler';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/common/auth/auth.decorator.js';
import { createTestApp, inject } from './support/create-test-app.js';

@Auth('ALL')
@Controller('test-rate')
class RateTestController {
  @Throttle({ default: { limit: 2, ttl: 60_000 } })
  @Get()
  limited() {
    return { ok: true };
  }
}

describe('rate limit', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp({ controllers: [RateTestController] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('한도를 넘으면 429 RATE_LIMITED와 Retry-After', async () => {
    const call = () => inject(app, { url: '/test-rate', remoteAddress: '10.0.0.1' });
    expect((await call()).statusCode).toBe(200);
    expect((await call()).statusCode).toBe(200);

    const blocked = await call();
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe('RATE_LIMITED');
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);

    const other = await inject(app, { url: '/test-rate', remoteAddress: '10.0.0.2' });
    expect(other.statusCode).toBe(200);
  });
});
