import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  auditLogs,
  type NewUser,
  notifications,
  reportGroups,
  reports,
  users,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { createTestApp, inject } from './support/create-test-app.js';

describe('관리자 신고 처리', () => {
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
      name: `신고처리${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 6 : null,
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

  const report = (from: AuthUser, target: AuthUser, reason: string) =>
    call(from, 'POST', '/reports', { targetType: 'USER', targetId: target.userId, reason });
  const groupsOf = (target: AuthUser) =>
    db.select().from(reportGroups).where(eq(reportGroups.targetId, target.userId));
  const resultNotifications = (userId: string) =>
    db
      .select({ body: notifications.body })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.type, 'REPORT_RESULT')));

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    admin = await makeUser({ role: 'TEACHER', isAdmin: true });
  });

  afterAll(async () => {
    await db.delete(reports).where(inArray(reports.reporterId, userIds));
    await db.delete(reportGroups).where(inArray(reportGroups.targetId, userIds));
    await db.delete(auditLogs).where(inArray(auditLogs.actorId, userIds));
    await db.delete(notifications).where(inArray(notifications.userId, userIds));
    await app.close();
  });

  it('같은 대상의 신고는 한 묶음이고, 신고한 사람은 보여 주지 않는다', async () => {
    const [a, b, target] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    await report(a, target, 'OFFENSIVE_REACTION');
    await report(b, target, 'CHEATING');
    await report(a, target, 'CHEATING');
    const [group] = await groupsOf(target);
    expect(await groupsOf(target)).toHaveLength(1);

    const list = (await call(admin, 'GET', '/admin/reports?reason=CHEATING&size=50')).json();
    const item = list.items.find((i: { reportGroupId: string }) => i.reportGroupId === group?.id);
    expect(item).toMatchObject({
      targetType: 'USER',
      target: { id: target.userId, label: expect.stringContaining('신고처리') },
      reportCount: 3,
      status: 'RECEIVED',
    });
    expect(item.reasons.sort()).toEqual(['CHEATING', 'OFFENSIVE_REACTION']);

    const detail = await call(admin, 'GET', `/admin/reports/${group?.id}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.reports).toHaveLength(3);
    expect(JSON.stringify(body)).not.toContain(a.userId);
    expect(JSON.stringify(body)).not.toContain(b.userId);
    expect(body).toMatchObject({
      targetHistory: { reportCount: 3, sanctions: [] },
      result: null,
      history: [],
    });
    expect((await call(admin, 'GET', `/admin/reports/${newId()}`)).json().code).toBe(
      'REPORT_NOT_FOUND',
    );
  });

  it('처리하면 묶음을 닫고 신고한 사람들에게 한 번 알리며, 결과 수정은 이력으로 남는다', async () => {
    const [a, b, target] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    await report(a, target, 'OFFENSIVE_REACTION');
    const [group] = await groupsOf(target);
    const url = `/admin/reports/${group?.id}`;

    expect((await call(admin, 'PATCH', url, { status: 'IN_REVIEW' })).statusCode).toBe(204);
    await report(b, target, 'CHEATING');
    expect(await groupsOf(target)).toHaveLength(1);
    expect(
      (
        await db
          .select()
          .from(reports)
          .where(eq(reports.groupId, group?.id as string))
      ).map((r) => r.status),
    ).toEqual(['IN_REVIEW', 'IN_REVIEW']);

    expect(
      (await call(admin, 'PATCH', url, { status: 'RESOLVED', result: 'DISMISSED' })).statusCode,
    ).toBe(400);
    expect(
      (
        await call(admin, 'PATCH', url, {
          status: 'RESOLVED',
          result: 'DISMISSED',
          memo: '문제 없음',
        })
      ).statusCode,
    ).toBe(204);
    for (const reporter of [a, b]) {
      expect(await resultNotifications(reporter.userId)).toEqual([
        { body: '신고하신 내용을 검토했지만 문제를 확인하지 못했어요.' },
      ]);
    }

    expect((await call(admin, 'PATCH', url, { status: 'IN_REVIEW' })).json().code).toBe(
      'REPORT_ALREADY_RESOLVED',
    );
    expect(
      (
        await call(admin, 'PATCH', url, {
          status: 'RESOLVED',
          result: 'WARNING',
          memo: '다시 보니 경고',
        })
      ).statusCode,
    ).toBe(204);
    expect(await resultNotifications(a.userId)).toHaveLength(1);

    const detail = (await call(admin, 'GET', url)).json();
    expect(detail.result).toMatchObject({
      result: 'WARNING',
      memo: '다시 보니 경고',
      adminName: expect.any(String),
    });
    expect(
      detail.history.map((h: { status: string; result: string | null }) => [h.status, h.result]),
    ).toEqual([
      ['IN_REVIEW', null],
      ['RESOLVED', 'DISMISSED'],
      ['RESOLVED', 'WARNING'],
    ]);

    // 처리한 뒤의 신고는 새 묶음
    await report(a, target, 'CHEATING');
    const groups = await groupsOf(target);
    expect(groups).toHaveLength(2);
    expect(groups.find((g) => g.id !== group?.id)).toMatchObject({
      status: 'RECEIVED',
      openKey: 1,
    });
  });

  it('관리자만 쓸 수 있다', async () => {
    const student = await makeUser();
    expect((await call(student, 'GET', '/admin/reports')).statusCode).toBe(403);
  });
});
