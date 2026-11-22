import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AccessTokenService } from './access-token.service.js';
import { AccountBlockService } from './account-block.service.js';
import { AuthErrors } from './auth-errors.js';
import { AUTH_KEY, type Authority } from './auth.decorator.js';

export const ACCESS_TOKEN_COOKIE = '__Host-at';

/** 토큰이 있으면 검증해 request.user를 채운다. 권한 판정은 AuthGuard가 한다. */
@Injectable()
export class AuthenticationGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
    private readonly blocks: AccountBlockService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = extractToken(request);
    if (!token) return true;

    try {
      const user = await this.tokens.verify(token);
      // 정지 직후에도 이미 받은 액세스 토큰으로 쓰지 못하게 한다
      if (await this.blocks.isBlocked(user.userId)) throw AuthErrors.accountSuspended(null, null);
      request.user = user;
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
