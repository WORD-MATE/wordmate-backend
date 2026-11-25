import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_TTL_SECONDS } from '../../common/auth/access-token.service.js';
import { ACCESS_TOKEN_COOKIE } from '../../common/auth/authentication.guard.js';
import {
  clearAuthCookies,
  REFRESH_TOKEN_COOKIE,
  readRefreshToken,
  setAuthCookies,
} from './auth-cookies.js';

const requestWith = (cookies?: Record<string, string>) => ({ cookies }) as FastifyRequest;

const recordingReply = () => {
  const calls: { method: string; name: string; value?: string; options: object }[] = [];
  const reply = {
    setCookie: (name: string, value: string, options: object) =>
      calls.push({ method: 'set', name, value, options }),
    clearCookie: (name: string, options: object) => calls.push({ method: 'clear', name, options }),
  } as unknown as FastifyReply;
  return { reply, calls };
};

describe('readRefreshToken', () => {
  it('본문(앱)을 쿠키(웹)보다 먼저 쓰고, 둘 다 없으면 null', () => {
    const request = requestWith({ [REFRESH_TOKEN_COOKIE]: 'from-cookie' });
    expect(readRefreshToken(request, 'from-body')).toBe('from-body');
    expect(readRefreshToken(request, null)).toBe('from-cookie');
    expect(readRefreshToken(requestWith(), null)).toBeNull();
    expect(readRefreshToken(requestWith({}), null)).toBeNull();
  });
});

describe('인증 쿠키', () => {
  it('액세스 토큰은 전체 경로, 리프레시 토큰은 /auth에만 보내고 둘 다 httpOnly·secure', () => {
    const { reply, calls } = recordingReply();
    setAuthCookies(reply, { accessToken: 'at', refreshToken: 'rt' });
    expect(calls).toEqual([
      {
        method: 'set',
        name: ACCESS_TOKEN_COOKIE,
        value: 'at',
        options: expect.objectContaining({
          httpOnly: true,
          secure: true,
          path: '/',
          maxAge: ACCESS_TOKEN_TTL_SECONDS,
        }),
      },
      {
        method: 'set',
        name: REFRESH_TOKEN_COOKIE,
        value: 'rt',
        options: expect.objectContaining({ httpOnly: true, secure: true, path: '/auth' }),
      },
    ]);
  });

  it('지울 때도 같은 경로로 지운다 (경로가 다르면 브라우저에서 지워지지 않는다)', () => {
    const { reply, calls } = recordingReply();
    clearAuthCookies(reply);
    expect(calls.map((c) => [c.method, c.name, (c.options as { path: string }).path])).toEqual([
      ['clear', ACCESS_TOKEN_COOKIE, '/'],
      ['clear', REFRESH_TOKEN_COOKIE, '/auth'],
    ]);
  });
});
