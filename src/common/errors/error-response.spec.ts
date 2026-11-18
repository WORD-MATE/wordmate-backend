import { BadRequestException, HttpStatus, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppException } from './app-exception.js';
import { toErrorResponse } from './error-response.js';

describe('toErrorResponse', () => {
  it('AppException의 코드·메시지·detail을 그대로 쓴다', () => {
    const e = new AppException('ROOM_FULL', '방이 가득 찼습니다.', HttpStatus.CONFLICT, {
      max: 30,
    });
    expect(toErrorResponse(e)).toEqual({
      status: 409,
      body: { code: 'ROOM_FULL', message: '방이 가득 찼습니다.', detail: { max: 30 } },
    });
  });

  it('Nest HttpException은 상태별 기본 코드로 바꾼다', () => {
    expect(toErrorResponse(new NotFoundException('Cannot GET /x'))).toEqual({
      status: 404,
      body: { code: 'NOT_FOUND', message: '리소스를 찾을 수 없습니다.', detail: null },
    });
    expect(toErrorResponse(new BadRequestException()).body.code).toBe('INVALID_REQUEST');
  });

  it('statusCode가 4xx인 Fastify 에러는 그 상태를 쓴다', () => {
    const e = Object.assign(new Error('Body is too large'), { statusCode: 413 });
    expect(toErrorResponse(e)).toMatchObject({ status: 413, body: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('알 수 없는 에러는 내부 메시지를 숨기고 500으로 바꾼다', () => {
    const res = toErrorResponse(new Error('connection password=secret'));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      code: 'INTERNAL_ERROR',
      message: '서버 내부 오류가 발생했습니다.',
      detail: null,
    });
  });
});
