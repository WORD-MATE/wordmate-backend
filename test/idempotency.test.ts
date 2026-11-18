import { randomUUID } from 'node:crypto';
import { Controller, HttpCode, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/common/auth/auth.decorator.js';
import { Idempotent } from '../src/common/idempotency/idempotent.decorator.js';
import { createTestApp, inject } from './support/create-test-app.js';

let counter = 0;

@Auth('ALL')
@Controller('test-idem')
class IdempotencyTestController {
  @Idempotent()
  @HttpCode(201)
  @Post()
  create() {
    counter += 1;
    return { count: counter };
  }

  @Idempotent()
  @Post('fail')
  fail() {
    counter += 1;
    throw new Error('일시 장애');
  }
}

describe('Idempotency-Key', () => {
  let app: NestFastifyApplication;

  const post = (url: string, key?: string) =>
    inject(app, { method: 'POST', url, headers: key ? { 'idempotency-key': key } : {} });

  beforeAll(async () => {
    app = await createTestApp({ controllers: [IdempotencyTestController] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('같은 키로 다시 보내면 처리하지 않고 처음 응답을 돌려준다', async () => {
    const key = randomUUID();
    const first = await post('/test-idem', key);
    const second = await post('/test-idem', key);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(second.headers['idempotent-replayed']).toBe('true');
  });

  it('키가 없거나 다르면 매번 처리한다', async () => {
    const a = (await post('/test-idem')).json().count;
    const b = (await post('/test-idem', randomUUID())).json().count;
    expect(b).toBe(a + 1);
  });

  it('실패한 요청은 저장하지 않아 같은 키로 재시도할 수 있다', async () => {
    const key = randomUUID();
    const before = counter;
    expect((await post('/test-idem/fail', key)).statusCode).toBe(500);
    expect((await post('/test-idem/fail', key)).statusCode).toBe(500);
    expect(counter).toBe(before + 2);
  });

  it('UUID가 아니면 400', async () => {
    const res = await post('/test-idem', 'not-uuid');
    expect(res.statusCode).toBe(400);
    expect(res.json().detail).toEqual({ header: 'Idempotency-Key' });
  });
});
