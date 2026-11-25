import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { CommonErrors } from '../errors/app-exception.js';
import type { AuthUser } from './auth-user.js';

/** 로그인 필수 엔드포인트에서 인증된 사용자를 꺼낸다. 공개(ALL) 엔드포인트에서 비로그인이면 401 */
export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): AuthUser => {
    const { user } = context.switchToHttp().getRequest<FastifyRequest>();
    if (!user) throw CommonErrors.unauthorized();
    return user;
  },
);
