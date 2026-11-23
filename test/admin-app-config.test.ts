import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG_KEY } from '../src/common/app-config/app-config.service.js';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { auditLogs, type NewUser, users } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { createTestApp, inject } from './support/create-test-app.js';

describe('관리자 앱 설정', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let valkey: Redis;
  let admin: AuthUser;
  let original: string | null;
  const userIds: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `설정${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 1 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (user: AuthUser, method: 'GET' | 'PUT', url: string, payload?: object) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const config = (overrides: object = {}) => ({
    maintenance: { enabled: false, message: '', endsAt: null },
    minVersion: { IOS: '1.0.0' },
    latestVersion: { IOS: '1.2.0' },
    storeUrl: { IOS: 'https://apps.apple.com/app/id0000000000' },
    ...overrides,
  });

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    valkey = app.get(VALKEY);
    original = await valkey.get(APP_CONFIG_KEY);
    admin = await makeUser({ role: 'TEACHER', isAdmin: true });
  });

  afterAll(async () => {
    if (!valkey) return;
    if (original === null) await valkey.del(APP_CONFIG_KEY);
    else await valkey.set(APP_CONFIG_KEY, original);
    await db.delete(auditLogs).where(inArray(auditLogs.actorId, userIds));
    await app.close();
  });

  it('점검을 켜면 관리자만 쓸 수 있고, 끄면 다시 열린다', async () => {
    const student = await makeUser();
    const on = await call(admin, 'PUT', '/admin/app-config', {
      ...config(),
      maintenance: { enabled: true, message: '정기 점검', endsAt: null },
    });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({
      maintenance: { enabled: true, message: '정기 점검' },
      minVersion: { IOS: '1.0.0' },
    });

    const blocked = await call(student, 'GET', '/users/me');
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json().code).toBe('MAINTENANCE');
    expect((await call(admin, 'GET', '/admin/app-config')).json().maintenance.enabled).toBe(true);

    expect((await call(admin, 'PUT', '/admin/app-config', config())).statusCode).toBe(200);
    expect((await call(student, 'GET', '/users/me')).statusCode).toBe(200);

    const logs = await db.select().from(auditLogs).where(eq(auditLogs.actorId, admin.userId));
    expect(logs.filter((l) => l.action === 'APP_CONFIG_CHANGE')).toHaveLength(2);
  });

  it('버전 형식과 최소·최신 순서를 검사한다', async () => {
    for (const body of [
      config({ minVersion: { IOS: '2.0.0' } }),
      config({ latestVersion: { IOS: 'v1' } }),
      config({ storeUrl: { IOS: '주소 아님' } }),
    ]) {
      expect((await call(admin, 'PUT', '/admin/app-config', body)).statusCode).toBe(400);
    }
  });

  it('관리자만 쓸 수 있다', async () => {
    const student = await makeUser();
    expect((await call(student, 'GET', '/admin/app-config')).statusCode).toBe(403);
  });
});
