import { Body, Controller, Get, HttpStatus, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Auth } from '../src/common/auth/auth.decorator.js';
import { AppException } from '../src/common/errors/app-exception.js';
import { createTestApp, inject } from './support/create-test-app.js';

@Auth('ALL')
@Controller('test-errors')
class ErrorTestController {
  @Get('app')
  app(): never {
    throw new AppException('ROOM_FULL', '방이 가득 찼습니다.', HttpStatus.CONFLICT, { max: 30 });
  }

  @Get('unknown')
  unknown(): never {
    throw new Error('db password=secret');
  }

  @Post('echo')
  echo(@Body() body: unknown): unknown {
    return body;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('에러 응답 형식', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ErrorTestController] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('AppException을 { code, message, detail, traceId }로 돌려준다', async () => {
    const res = await inject(app, { method: 'GET', url: '/test-errors/app' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      code: 'ROOM_FULL',
      message: '방이 가득 찼습니다.',
      detail: { max: 30 },
      traceId: expect.stringMatching(UUID),
    });
  });

  it('예상하지 못한 에러는 내부 내용을 숨기고 500을 돌려준다', async () => {
    const res = await inject(app, { method: 'GET', url: '/test-errors/unknown' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'INTERNAL_ERROR', detail: null });
    expect(res.body).not.toContain('secret');
    expect(res.body).not.toContain('at ');
  });

  it('없는 경로는 404 NOT_FOUND', async () => {
    const res = await inject(app, { method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'NOT_FOUND', detail: null });
  });

  it('JSON 형식이 틀리면 400 INVALID_REQUEST', async () => {
    const res = await inject(app, {
      method: 'POST',
      url: '/test-errors/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'INVALID_REQUEST',
      traceId: expect.stringMatching(UUID),
    });
  });
});
