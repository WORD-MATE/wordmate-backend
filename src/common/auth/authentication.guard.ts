import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AccessTokenService } from './access-token.service.js';
import { AUTH_KEY, type Authority } from './auth.decorator.js';

export const ACCESS_TOKEN_COOKIE = '__Host-at';

/** 토큰이 있으면 검증해 request.user를 채운다. 권한 판정은 AuthGuard가 한다. */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = extractToken(request);
    if (!token) return true;

    try {
      request.user = await this.tokens.verify(token);
    } catch (error) {
      const authorities = this.reflector.getAllAndOverride<Authority[] | undefined>(AUTH_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      // 공개 API는 만료·잘못된 토큰이 붙어 와도 비로그인으로 처리한다
      if (!authorities?.includes('ALL')) throw error;
    }
    return true;
  }
}

function extractToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim() || null;
  return request.cookies?.[ACCESS_TOKEN_COOKIE] ?? null;
}
