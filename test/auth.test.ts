import { Controller, Get } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import { Auth } from '../src/common/auth/auth.decorator.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { createTestApp, inject } from './support/create-test-app.js';

@Controller('test-auth')
class AuthTestController {
  @Get('default')
  byDefault() {
    return { ok: true };
  }

  @Auth('ALL')
  @Get('public')
  open() {
    return { ok: true };
  }

  @Auth('STUDENT')
  @Get('student')
  student() {
    return { ok: true };
  }

  @Auth('TEACHER', 'ADMIN')
  @Get('teacher-or-admin')
  teacherOrAdmin() {
    return { ok: true };
  }
}

const student: AuthUser = { userId: 's', role: 'STUDENT', isAdmin: false, deviceId: 'd' };
const teacher: AuthUser = { userId: 't', role: 'TEACHER', isAdmin: false, deviceId: 'd' };
const adminStudent: AuthUser = { userId: 'a', role: 'STUDENT', isAdmin: true, deviceId: 'd' };

describe('권한 가드', () => {
  let app: NestFastifyApplication;

  const call = async (url: string, user?: AuthUser) =>
    inject(app, {
      url: `/test-auth/${url}`,
      headers: user
        ? { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` }
        : {},
    });

  beforeAll(async () => {
    app = await createTestApp({ controllers: [AuthTestController] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('ALL은 로그인 없이 통과하고, 잘못된 토큰이 붙어도 비로그인으로 처리한다', async () => {
    expect((await call('public')).statusCode).toBe(200);
    const res = await inject(app, {
      url: '/test-auth/public',
      headers: { authorization: 'Bearer broken' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('로그인이 필요한 API에 잘못된 토큰을 보내면 401 AUTH_INVALID', async () => {
    const res = await inject(app, {
      url: '/test-auth/default',
      headers: { authorization: 'Bearer broken' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('AUTH_INVALID');
  });

  it('웹은 __Host-at 쿠키로 인증한다', async () => {
    const token = await app.get(AccessTokenService).sign(teacher);
    const res = await inject(app, { url: '/test-auth/default', cookies: { '__Host-at': token } });
    expect(res.statusCode).toBe(200);
  });

  it('@Auth가 없으면 로그인이 필요하다', async () => {
    const res = await call('default');
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('AUTH_INVALID');
    expect((await call('default', teacher)).statusCode).toBe(200);
  });

  it('역할이 맞지 않으면 403 FORBIDDEN', async () => {
    expect((await call('student', student)).statusCode).toBe(200);
    const res = await call('student', teacher);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
  });

  it('여러 권한 중 하나만 맞으면 통과한다', async () => {
    expect((await call('teacher-or-admin', teacher)).statusCode).toBe(200);
    expect((await call('teacher-or-admin', adminStudent)).statusCode).toBe(200);
    expect((await call('teacher-or-admin', student)).statusCode).toBe(403);
  });
});
