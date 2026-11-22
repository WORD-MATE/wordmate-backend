import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditLogService } from '../src/common/audit/audit-log.service.js';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  auditLogs,
  classes,
  type NewUser,
  teacherClasses,
  users,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { createTestApp, inject } from './support/create-test-app.js';

describe('관리자 감사 로그', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'TEACHER';
    await db.insert(users).values({
      id: userId,
      name: `감사${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 1 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const list = async (user: AuthUser, query = '') =>
    inject(app, {
      method: 'GET',
      url: `/admin/audit-logs${query}`,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
  });

  afterAll(async () => {
    await db.delete(auditLogs).where(inArray(auditLogs.actorId, userIds));
    await app.close();
  });

  it('최신순으로 보여 주고 행위자·대상으로 거른다', async () => {
    const admin = await makeUser({ isAdmin: true });
    const teacher = await makeUser();
    const audit = app.get(AuditLogService);
    for (const n of [1, 2, 3]) {
      await audit.record({
        actorId: teacher.userId,
        action: 'TEACHER_CLASS_CHANGE',
        targetType: 'USER',
        targetId: teacher.userId,
        detail: { n },
      });
    }

    const res = await list(admin, `?actorId=${teacher.userId}&size=2`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCount).toBe(3);
    expect(body.items.map((i: { detail: { n: number } }) => i.detail.n)).toEqual([3, 2]);
    expect(body.items[0]).toMatchObject({
      actor: { userId: teacher.userId },
      action: 'TEACHER_CLASS_CHANGE',
      targetType: 'USER',
      targetId: teacher.userId,
      ip: null,
    });
    const second = (await list(admin, `?actorId=${teacher.userId}&size=2&page=1`)).json();
    expect(second.items.map((i: { detail: { n: number } }) => i.detail.n)).toEqual([1]);

    expect((await list(admin, `?targetId=${newId()}`)).json()).toEqual({
      totalCount: 0,
      items: [],
    });
    expect(
      (await list(admin, `?actorId=${teacher.userId}&from=2000-01-01&to=2000-01-02`)).json(),
    ).toMatchObject({ totalCount: 0 });
    expect((await list(admin, '?from=2026-02-01&to=2026-01-01')).statusCode).toBe(400);
    expect((await list(admin, '?targetId=')).statusCode).toBe(400);
  });

  it('관리자만 볼 수 있다', async () => {
    const teacher = await makeUser();
    // 담당 반이 있어야 반 선택 안내가 아니라 권한 검사에서 막힌다
    const [someClass] = await db.select({ id: classes.id }).from(classes).limit(1);
    await db
      .insert(teacherClasses)
      .values({ teacherId: teacher.userId, classId: someClass?.id as string });
    const student = await makeUser({ role: 'STUDENT' });
    const res = await list(teacher);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FORBIDDEN');
    expect((await list(student)).statusCode).toBe(403);
  });
});
