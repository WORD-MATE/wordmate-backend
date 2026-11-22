import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  auditLogs,
  devices,
  type NewUser,
  notifications,
  sanctions,
  users,
  xpLedger,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { SessionService } from '../src/modules/auth/session.service.js';
import { ACCOUNT_SUSPENDED_CLOSE_CODE } from '../src/modules/realtime/realtime.service.js';
import { createTestApp, inject } from './support/create-test-app.js';
import { connectAs } from './support/ws-client.js';

describe('제재', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let admin: AuthUser;
  const userIds: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `제재${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 3 : null,
      classNo: role === 'STUDENT' ? 3 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (
    user: AuthUser,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: object,
  ) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const sanction = (body: object) => call(admin, 'POST', '/admin/sanctions', body);
  const notificationsOf = (userId: string) =>
    db
      .select({ title: notifications.title, body: notifications.body })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.type, 'SANCTION')));
  const inAnHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    await app.listen(0, '127.0.0.1');
    admin = await makeUser({ role: 'TEACHER', isAdmin: true });
  });

  afterAll(async () => {
    await db.delete(auditLogs).where(inArray(auditLogs.actorId, userIds));
    await db.delete(notifications).where(inArray(notifications.userId, userIds));
    await db.delete(xpLedger).where(inArray(xpLedger.userId, userIds));
    await app.close();
  });

  it('경고와 XP 회수는 알림으로 알리고, 가진 만큼만 회수한다', async () => {
    const user = await makeUser({ totalXp: 50 });
    const warn = await sanction({ userId: user.userId, type: 'WARNING', reason: '욕설' });
    expect(warn.statusCode).toBe(201);
    expect(warn.json().sanctionId).toEqual(expect.any(String));

    const revoke = await sanction({
      userId: user.userId,
      type: 'XP_REVOKE',
      reason: '부정행위',
      revokeXp: 100,
    });
    expect(revoke.statusCode).toBe(201);
    const [row] = await db.select().from(users).where(eq(users.id, user.userId));
    expect(row?.totalXp).toBe(0);
    expect(
      (await db.select().from(xpLedger).where(eq(xpLedger.userId, user.userId))).map((l) => [
        l.source,
        l.amount,
      ]),
    ).toEqual([['ADMIN_ADJUST', -50]]);
    expect(await notificationsOf(user.userId)).toEqual(
      expect.arrayContaining([
        { title: '경고', body: '욕설' },
        { title: 'XP 회수', body: '부정행위 (XP 50 회수)' },
      ]),
    );
    expect(
      (await db.select().from(auditLogs).where(eq(auditLogs.targetId, user.userId))).map(
        (l) => l.action,
      ),
    ).toEqual(['SANCTION_APPLY', 'SANCTION_APPLY']);
  });

  it('정지하면 모든 세션과 남은 액세스 토큰을 막고, 해제하면 다시 쓸 수 있다', async () => {
    const user = await makeUser();
    await app.get(SessionService).create(user.userId, 'IOS');
    const socket = await connectAs(app, user);
    expect((await call(user, 'GET', '/users/me')).statusCode).toBe(200);

    const until = inAnHour();
    expect(
      (
        await sanction({
          userId: user.userId,
          type: 'SUSPEND',
          reason: '도배',
          suspendedUntil: until,
        })
      ).statusCode,
    ).toBe(201);
    const [row] = await db.select().from(users).where(eq(users.id, user.userId));
    expect(row).toMatchObject({ status: 'SUSPENDED', suspendReason: '도배' });
    expect(row?.suspendedUntil?.toISOString()).toBe(until);
    const live = await db.select().from(devices).where(eq(devices.userId, user.userId));
    expect(live.every((d) => d.revokedAt !== null)).toBe(true);
    const blocked = await call(user, 'GET', '/users/me');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('ACCOUNT_SUSPENDED');
    // 이미 열린 연결은 다음 메시지에서 끊긴다
    socket.send('PING');
    expect(await socket.closed).toBe(ACCOUNT_SUSPENDED_CLOSE_CODE);

    const detail = (await call(admin, 'GET', `/admin/users/${user.userId}`)).json();
    expect(detail).toMatchObject({ status: 'SUSPENDED', suspendedUntil: until });
    expect(detail.sanctions).toEqual([
      expect.objectContaining({
        type: 'SUSPEND',
        reason: '도배',
        until,
        adminName: expect.any(String),
      }),
    ]);

    const lift = await call(admin, 'PATCH', `/admin/users/${user.userId}/status`, {
      status: 'ACTIVE',
      reason: '오해',
    });
    expect(lift.statusCode).toBe(204);
    expect((await call(user, 'GET', '/users/me')).statusCode).toBe(200);
    expect(
      (
        await call(admin, 'PATCH', `/admin/users/${user.userId}/status`, {
          status: 'ACTIVE',
          reason: '다시',
        })
      ).json().code,
    ).toBe('ADMIN_NOT_SUSPENDED');
  });

  it('기간 없이 정지하면 영구 정지', async () => {
    const user = await makeUser();
    const res = await call(admin, 'PATCH', `/admin/users/${user.userId}/status`, {
      status: 'SUSPENDED',
      reason: '반복 위반',
    });
    expect(res.statusCode).toBe(204);
    const [row] = await db.select().from(sanctions).where(eq(sanctions.userId, user.userId));
    expect(row).toMatchObject({ type: 'BAN', suspendedUntil: null, adminId: admin.userId });
    const [account] = await db.select().from(users).where(eq(users.id, user.userId));
    expect(account).toMatchObject({ status: 'SUSPENDED', suspendedUntil: null });
  });

  it('잘못된 요청과 자기 자신', async () => {
    const user = await makeUser();
    for (const body of [
      { userId: user.userId, type: 'SUSPEND', reason: '기간 없음' },
      {
        userId: user.userId,
        type: 'SUSPEND',
        reason: '지난 시각',
        suspendedUntil: '2000-01-01T00:00:00.000Z',
      },
      { userId: user.userId, type: 'XP_REVOKE', reason: '양 없음' },
      { userId: user.userId, type: 'WARNING', reason: '   ' },
      { userId: user.userId, type: 'WARNING', reason: '섞임', revokeXp: 10 },
    ]) {
      expect((await sanction(body)).statusCode).toBe(400);
    }
    expect(
      (await sanction({ userId: admin.userId, type: 'WARNING', reason: '나' })).json().code,
    ).toBe('ADMIN_SELF_ACTION');
    expect((await sanction({ userId: newId(), type: 'WARNING', reason: '없음' })).json().code).toBe(
      'USER_NOT_FOUND',
    );
    expect(
      (
        await call(user, 'POST', '/admin/sanctions', {
          userId: admin.userId,
          type: 'WARNING',
          reason: 'x',
        })
      ).statusCode,
    ).toBe(403);
  });
});
