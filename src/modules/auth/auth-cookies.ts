import type { FastifyReply, FastifyRequest } from 'fastify';
import { ACCESS_TOKEN_TTL_SECONDS } from '../../common/auth/access-token.service.js';
import { ACCESS_TOKEN_COOKIE } from '../../common/auth/authentication.guard.js';
import { REFRESH_TOKEN_TTL_MS } from './session.service.js';

export const REFRESH_TOKEN_COOKIE = '__Secure-rt';
const REFRESH_COOKIE_PATH = '/auth';

const base = { httpOnly: true, secure: true, sameSite: 'lax' } as const;

export function setAuthCookies(
  reply: FastifyReply,
  tokens: { accessToken: string; refreshToken: string },
): void {
  reply.setCookie(ACCESS_TOKEN_COOKIE, tokens.accessToken, {
    ...base,
    path: '/',
    maxAge: ACCESS_TOKEN_TTL_SECONDS,
  });
  reply.setCookie(REFRESH_TOKEN_COOKIE, tokens.refreshToken, {
    ...base,
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TOKEN_TTL_MS / 1000,
  });
}

export function clearAuthCookies(reply: FastifyReply): void {
  reply.clearCookie(ACCESS_TOKEN_COOKIE, { ...base, path: '/' });
  reply.clearCookie(REFRESH_TOKEN_COOKIE, { ...base, path: REFRESH_COOKIE_PATH });
}

export function readRefreshToken(request: FastifyRequest, fromBody: string | null): string | null {
  return fromBody ?? request.cookies?.[REFRESH_TOKEN_COOKIE] ?? null;
}
