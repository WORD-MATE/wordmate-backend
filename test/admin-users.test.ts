import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { kstDate } from '../src/common/time/kst.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  auditLogs,
  classes,
  type NewUser,
  teacherClasses,
  users,
  xpLedger,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { rankKey, xpOfScore } from '../src/modules/ranking/ranking-keys.js';
import { XpService } from '../src/modules/xp/xp.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

describe('관리자 사용자 관리', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let valkey: Redis;
  let admin: AuthUser;
  const userIds: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `관리대상${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 2 : null,
      classNo: role === 'STUDENT' ? 7 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (
    user: AuthUser,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: object,
  ) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const actionsBy = async (actorId: string) =>
    (await db.select().from(auditLogs).where(eq(auditLogs.actorId, actorId))).map((l) => l.action);

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    valkey = app.get(VALKEY);
    admin = await makeUser({ role: 'TEACHER', isAdmin: true });
  });

  afterAll(async () => {
    await db.delete(auditLogs).where(inArray(auditLogs.actorId, userIds));
    await db.delete(xpLedger).where(inArray(xpLedger.userId, userIds));
    await app.close();
  });

  it('학번·이름으로 찾고 상세를 보며, 조회도 감사 로그에 남는다', async () => {
    const studentNumber = `9${newId().replace(/\D/g, '').slice(-3)}`;
    const tag = newId().slice(-6);
    const target = await makeUser({ studentNumber, name: `찾을학생${tag}` });
    const byNumber = (
      await call(admin, 'GET', `/admin/users?q=${studentNumber.slice(0, 3)}`)
    ).json();
    expect(byNumber.items.map((i: { user: { userId: string } }) => i.user.userId)).toContain(
      target.userId,
    );
    const byName = (
      await call(
        admin,
        'GET',
        `/admin/users?q=${encodeURIComponent(`찾을학생${tag}`)}&role=STUDENT`,
      )
    ).json();
    expect(byName.items).toEqual([
      expect.objectContaining({
        user: expect.objectContaining({ userId: target.userId }),
        studentNumber,
        role: 'STUDENT',
        isAdmin: false,
        status: 'ACTIVE',
      }),
    ]);

    const detail = await call(admin, 'GET', `/admin/users/${target.userId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      teacherClasses: [],
      level: { level: 1, totalXp: 0 },
      studySummary: { solvedCount: 0, accuracy: null, lastStudiedAt: null },
      battleSummary: { total: 0, winCount: 0, leftCount: 0 },
      reportCount: 0,
    });
    expect((await call(admin, 'GET', `/admin/users/${newId()}`)).json().code).toBe(
      'USER_NOT_FOUND',
    );
    expect(await actionsBy(admin.userId)).toEqual(
      expect.arrayContaining(['ADMIN_USER_SEARCH', 'ADMIN_USER_VIEW']),
    );
  });

  it('관리자 권한은 학생·교사 모두에게 주고 회수할 수 있다', async () => {
    const teacher = await makeUser({ role: 'TEACHER' });
    const student = await makeUser();
    expect(
      (await call(admin, 'PUT', `/admin/users/${student.userId}/admin`, { isAdmin: true }))
        .statusCode,
    ).toBe(204);
    expect(
      (await call(admin, 'PUT', `/admin/users/${student.userId}/admin`, { isAdmin: false }))
        .statusCode,
    ).toBe(204);
    expect(
      (await call(admin, 'PUT', `/admin/users/${teacher.userId}/admin`, { isAdmin: true }))
        .statusCode,
    ).toBe(204);
    const [granted] = await db.select().from(users).where(eq(users.id, teacher.userId));
    expect(granted?.isAdmin).toBe(true);
    expect(
      (await call(admin, 'PUT', `/admin/users/${teacher.userId}/admin`, { isAdmin: false }))
        .statusCode,
    ).toBe(204);
    expect(await actionsBy(admin.userId)).toEqual(
      expect.arrayContaining(['ADMIN_GRANT', 'ADMIN_REVOKE']),
    );
  });

  it('교사 담당 반을 바꾸고, 행위자는 관리자로 남는다', async () => {
    const teacher = await makeUser({ role: 'TEACHER' });
    const student = await makeUser();
    const [cls] = await db.select().from(classes).limit(1);
    const res = await call(admin, 'PUT', `/admin/users/${teacher.userId}/classes`, {
      classIds: [cls?.id],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ classId: cls?.id, grade: cls?.grade, classNo: cls?.classNo }]);
    expect(
      await db.select().from(teacherClasses).where(eq(teacherClasses.teacherId, teacher.userId)),
    ).toHaveLength(1);
    const [log] = await db
      .select()
      .from(auditLogs)
      .where(
        and(eq(auditLogs.targetId, teacher.userId), eq(auditLogs.action, 'TEACHER_CLASS_CHANGE')),
      );
    expect(log?.actorId).toBe(admin.userId);
    expect(
      (
        await call(admin, 'PUT', `/admin/users/${student.userId}/classes`, { classIds: [cls?.id] })
      ).json().code,
    ).toBe('ADMIN_NOT_TEACHER');
  });

  it('XP 조정: 0 아래로는 못 내리고, 랭킹에 반영되며 하루 상한에 들어가지 않는다', async () => {
    const student = await makeUser();
    const url = `/admin/users/${student.userId}/xp-adjustments`;
    const up = await call(admin, 'POST', url, { delta: 600, reason: '대회 보상' });
    expect(up.statusCode).toBe(200);
    expect(up.json()).toEqual({ totalXp: 600, level: 1 });
    expect((await call(admin, 'POST', url, { delta: -601, reason: '회수' })).json().code).toBe(
      'ADMIN_XP_NEGATIVE',
    );
    expect((await call(admin, 'POST', url, { delta: -100, reason: '회수' })).json()).toEqual({
      totalXp: 500,
      level: 1,
    });
    expect((await call(admin, 'POST', url, { delta: 10 })).statusCode).toBe(400);

    const ledger = await db
      .select()
      .from(xpLedger)
      .where(eq(xpLedger.userId, student.userId))
      .orderBy(asc(xpLedger.id));
    expect(ledger.map((l) => [l.source, l.amount])).toEqual([
      ['ADMIN_ADJUST', 600],
      ['ADMIN_ADJUST', -100],
    ]);
    const score = await valkey.zscore(rankKey('ALL', kstDate(), 'class:2-7'), student.userId);
    expect(xpOfScore(Number(score))).toBe(500);

    const grant = await db.transaction((tx) =>
      app
        .get(XpService)
        .grant(tx, student.userId, [{ source: 'STUDY', refKey: newId(), amount: 10 }]),
    );
    expect(grant).toMatchObject({ earned: 10, capped: false, todayTotal: 10 });
    expect(await actionsBy(admin.userId)).toContain('XP_ADJUST');
  });

  it('관리자만 쓸 수 있다', async () => {
    const student = await makeUser();
    expect((await call(student, 'GET', '/admin/users')).statusCode).toBe(403);
  });
});
