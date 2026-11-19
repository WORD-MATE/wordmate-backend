import { randomUUID } from 'node:crypto';
import { Controller, Get, Req } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppConfigService } from '../src/common/app-config/app-config.service.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { users } from '../src/infra/db/schema/index.js';
import type { DataGsmProfile } from '../src/modules/auth/datagsm/datagsm.client.js';
import { DataGsmClient } from '../src/modules/auth/datagsm/datagsm.client.js';
import { createTestApp, inject } from './support/create-test-app.js';
import { TEST_REDIRECT_URI } from './support/test-env.js';

@Controller('test-me')
class WhoAmIController {
  @Get()
  whoami(@Req() request: FastifyRequest) {
    return request.user;
  }
}

const studentProfile = (datagsmId: string): DataGsmProfile => ({
  datagsmId,
  email: `${datagsmId}@gsm.hs.kr`,
  role: 'STUDENT',
  name: '김학생',
  studentNumber: '2307',
  grade: 2,
  classNo: 3,
  number: 7,
  inactive: false,
  pending: false,
});

describe('DataGSM 로그인·토큰 재발급·로그아웃', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let profile: DataGsmProfile;

  const fakeDataGsm = {
    exchangeCode: async () => 'datagsm-access-token',
    getProfile: async () => profile,
  };

  let loginCount = 0;
  // 테스트끼리 로그인 요청 제한을 나눠 쓰지 않게 요청마다 IP를 바꾼다
  const login = (platform: 'IOS' | 'WEB' = 'IOS', redirectUri = TEST_REDIRECT_URI) =>
    inject(app, {
      method: 'POST',
      url: '/auth/datagsm',
      remoteAddress: `10.0.0.${++loginCount}`,
      headers: { 'x-client-platform': platform },
      payload: { code: 'auth-code', codeVerifier: 'v'.repeat(43), redirectUri },
    });

  const refresh = (refreshToken: string) =>
    inject(app, { method: 'POST', url: '/auth/refresh', payload: { refreshToken } });

  beforeAll(async () => {
    app = await createTestApp({
      controllers: [WhoAmIController],
      overrides: [[DataGsmClient, fakeDataGsm]],
    });
    db = app.get(DB);
  });

  beforeEach(() => {
    profile = studentProfile(randomUUID());
  });

  afterAll(async () => {
    await app.close();
  });

  it('처음 로그인하면 계정을 만들고 토큰·Me·nextStep을 돌려준다', async () => {
    const res = await login();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      expiresIn: 1800,
      nextStep: 'HOME',
      user: {
        name: '김학생',
        role: 'STUDENT',
        grade: 2,
        classNo: 3,
        number: 7,
        studentNumber: '2307',
        isAdmin: false,
        teacherClasses: [],
      },
    });
    expect(body.accessToken).toEqual(expect.any(String));
    expect(body.refreshToken).toEqual(expect.any(String));

    const me = await inject(app, {
      url: '/test-me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.json()).toMatchObject({ userId: body.user.userId, role: 'STUDENT' });
  });

  it('다시 로그인하면 같은 계정의 학적 정보를 갱신한다', async () => {
    const first = (await login()).json();
    profile = { ...profile, name: '김학생2', grade: 3 };
    const second = (await login()).json();

    expect(second.user.userId).toBe(first.user.userId);
    expect(second.user).toMatchObject({ name: '김학생2', grade: 3 });
  });

  it('웹은 토큰을 쿠키로 발급하고 본문 토큰은 null', async () => {
    const res = await login('WEB');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ accessToken: null, refreshToken: null });

    const cookies = Object.fromEntries(res.cookies.map((c) => [c.name, c]));
    expect(cookies['__Host-at']).toMatchObject({ httpOnly: true, secure: true, path: '/' });
    expect(cookies['__Secure-rt']).toMatchObject({ httpOnly: true, secure: true, path: '/auth' });

    const refreshed = await inject(app, {
      method: 'POST',
      url: '/auth/refresh',
      headers: { 'x-client-platform': 'WEB' },
      cookies: { '__Secure-rt': cookies['__Secure-rt']?.value ?? '' },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json()).toMatchObject({ accessToken: null, refreshToken: null });
    expect(refreshed.cookies.map((c) => c.name)).toContain('__Host-at');
  });

  it('허용 목록에 없는 redirectUri는 400', async () => {
    const res = await login('IOS', 'https://evil.example/callback');
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'INVALID_REQUEST', detail: { field: 'redirectUri' } });
  });

  it('졸업·자퇴생은 403 ACCOUNT_INACTIVE, 기존 계정은 INACTIVE로 바뀐다', async () => {
    const first = (await login()).json();
    profile = { ...profile, inactive: true };

    const res = await login();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      code: 'ACCOUNT_INACTIVE',
      detail: { reason: 'GRADUATED_OR_LEFT' },
    });
    const [row] = await db.select().from(users).where(eq(users.id, first.user.userId));
    expect(row?.status).toBe('INACTIVE');
  });

  it('정지된 계정은 403 ACCOUNT_SUSPENDED, 정지 기간이 지나면 다시 로그인된다', async () => {
    const { user } = (await login()).json();
    const until = new Date(Date.now() + 86_400_000);
    await db
      .update(users)
      .set({ status: 'SUSPENDED', suspendedUntil: until, suspendReason: '부정 사용' })
      .where(eq(users.id, user.userId));

    const blocked = await login();
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({
      code: 'ACCOUNT_SUSPENDED',
      detail: { reason: '부정 사용', until: until.toISOString() },
    });

    await db
      .update(users)
      .set({ suspendedUntil: new Date(Date.now() - 1000) })
      .where(eq(users.id, user.userId));
    expect((await login()).statusCode).toBe(200);
  });

  it('리프레시 토큰을 회전하고, 이미 쓴 토큰이 다시 오면 기기의 토큰 전체를 폐기한다', async () => {
    const { refreshToken: first } = (await login()).json();

    const rotated = await refresh(first);
    expect(rotated.statusCode).toBe(200);
    const second = rotated.json().refreshToken;
    expect(second).not.toBe(first);

    const reused = await refresh(first);
    expect(reused.statusCode).toBe(401);
    expect(reused.json().code).toBe('AUTH_REFRESH_REUSED');

    const afterReuse = await refresh(second);
    expect(afterReuse.statusCode).toBe(401);
    expect(afterReuse.json().code).toBe('AUTH_REFRESH_EXPIRED');
  });

  it('없는 리프레시 토큰은 401 AUTH_REFRESH_EXPIRED', async () => {
    const res = await refresh('nope');
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('AUTH_REFRESH_EXPIRED');
  });

  it('로그아웃은 액세스 토큰 없이 리프레시 토큰만으로 되고, 이후 재발급은 실패한다', async () => {
    const { refreshToken } = (await login()).json();
    const res = await inject(app, {
      method: 'POST',
      url: '/auth/logout',
      payload: { refreshToken },
    });
    expect(res.statusCode).toBe(204);
    expect((await refresh(refreshToken)).statusCode).toBe(401);
  });

  it('점검 중에도 로그인할 수 있다', async () => {
    const config = app.get(AppConfigService);
    await config.set({ maintenance: { enabled: true, message: '점검', endsAt: null } });
    try {
      expect((await login()).statusCode).toBe(200);
      expect((await inject(app, { url: '/test-me' })).statusCode).toBe(503);
    } finally {
      await config.set({});
    }
  });
});
