import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  auditLogs,
  jobRuns,
  type NewUser,
  notifications,
  rankingSeasons,
  rankingSnapshots,
  reportGroups,
  users,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { encodeScore } from '../src/modules/ranking/ranking-keys.js';
import { createTestApp, inject } from './support/create-test-app.js';

// 매시간 도는 마감 작업이 건드리지 않도록 아주 지난 기간을 쓴다
const WEEK = '2001-01-01';
const MONTH = '2001-02';
const CLASS_SCOPE = 'class:7-31';
const MONTH_KEYS = [`rank:monthly:${MONTH}:school`, `rank:monthly:${MONTH}:${CLASS_SCOPE}`];

describe('관리자 시즌 관리', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let valkey: Redis;
  let admin: AuthUser;
  let s1: AuthUser;
  let hidden: AuthUser;
  let s2: AuthUser;
  let s3: AuthUser;
  let s4: AuthUser;
  const userIds: string[] = [];
  const weeklyId = newId();
  const monthlyId = newId();

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `시즌관리${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 7 : null,
      classNo: role === 'STUDENT' ? 31 : null,
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

  const ranksOf = async (seasonId: string, scope: string) =>
    (
      await db
        .select({ userId: rankingSnapshots.userId, rank: rankingSnapshots.rank })
        .from(rankingSnapshots)
        .where(and(eq(rankingSnapshots.seasonId, seasonId), eq(rankingSnapshots.scope, scope)))
        .orderBy(asc(rankingSnapshots.position))
    ).map((row) => [row.userId, row.rank]);

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    valkey = app.get<Redis>(VALKEY);
    admin = await makeUser({ role: 'TEACHER', isAdmin: true });
    s1 = await makeUser();
    hidden = await makeUser({ rankingPublic: false });
    s2 = await makeUser();
    s3 = await makeUser();
    s4 = await makeUser();

    await db.insert(rankingSeasons).values([
      {
        id: weeklyId,
        period: 'WEEKLY',
        periodKey: WEEK,
        startsOn: WEEK,
        endsOn: '2001-01-08',
        status: 'CONFIRMED',
        attempts: 1,
        confirmedAt: new Date('2001-01-08T00:10:00Z'),
      },
      {
        id: monthlyId,
        period: 'MONTHLY',
        periodKey: MONTH,
        startsOn: `${MONTH}-01`,
        endsOn: '2001-03-01',
        status: 'FAILED',
        attempts: 2,
        lastError: 'Error: valkey down',
      },
    ]);
    const closed = [
      { user: s1, xp: 500, listed: true, rank: 1 },
      { user: hidden, xp: 400, listed: false, rank: 2 },
      { user: s2, xp: 300, listed: true, rank: 2 },
      { user: s3, xp: 300, listed: true, rank: 3 },
      { user: s4, xp: 100, listed: true, rank: 4 },
    ];
    await db.insert(rankingSnapshots).values(
      ['school', CLASS_SCOPE].flatMap((scope) =>
        closed.map((m, position) => ({
          seasonId: weeklyId,
          scope,
          userId: m.user.userId,
          xp: m.xp,
          listed: m.listed,
          rank: m.rank,
          position,
        })),
      ),
    );
    await db.insert(reportGroups).values([
      {
        targetType: 'USER',
        targetId: s2.userId,
        status: 'RECEIVED',
        lastReportedAt: new Date(),
      },
      {
        targetType: 'USER',
        targetId: s3.userId,
        status: 'RESOLVED',
        openKey: null,
        lastReportedAt: new Date(),
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(rankingSeasons).where(inArray(rankingSeasons.id, [weeklyId, monthlyId]));
    await db.delete(reportGroups).where(inArray(reportGroups.targetId, userIds));
    await db.delete(auditLogs).where(inArray(auditLogs.actorId, userIds));
    await db.delete(notifications).where(inArray(notifications.userId, userIds));
    await db
      .delete(jobRuns)
      .where(and(eq(jobRuns.job, 'SEASON_CLOSE'), eq(jobRuns.trigger, 'MANUAL')));
    await valkey.del(...MONTH_KEYS);
    await app.close();
  });

  it('목록: 주기·상태로 거르고, 순위에 든 사용자가 대상인 처리 전 신고 수를 보여 준다', async () => {
    const res = await call(admin, 'GET', '/admin/seasons?period=WEEKLY&status=CONFIRMED&size=100');
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { seasonId: string; period: string }[];
    expect(items.every((s) => s.period === 'WEEKLY')).toBe(true);
    expect(items.find((s) => s.seasonId === weeklyId)).toEqual({
      seasonId: weeklyId,
      period: 'WEEKLY',
      periodKey: WEEK,
      startDate: WEEK,
      endDate: '2001-01-07',
      status: 'CONFIRMED',
      pendingReportCount: 1,
      closedAt: '2001-01-08T00:10:00.000Z',
    });
    expect(items.some((s) => s.seasonId === monthlyId)).toBe(false);

    const failed = await call(admin, 'GET', '/admin/seasons?status=FAILED&size=100');
    expect(failed.json().items.map((s: { seasonId: string }) => s.seasonId)).toContain(monthlyId);
    expect((await call(admin, 'GET', '/admin/seasons?period=DAILY')).statusCode).toBe(400);
  });

  it('상세: 학교 범위 순위와 실패 사유', async () => {
    const res = await call(admin, 'GET', `/admin/seasons/${weeklyId}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ error: null, attempts: 1, exclusions: [] });
    expect(
      body.ranking.map((r: { user: { userId: string }; rank: number; listed: boolean }) => [
        r.user.userId,
        r.rank,
        r.listed,
      ]),
    ).toEqual([
      [s1.userId, 1, true],
      [hidden.userId, 2, false],
      [s2.userId, 2, true],
      [s3.userId, 3, true],
      [s4.userId, 4, true],
    ]);
    expect(body.ranking[0]).toMatchObject({ xp: 500, excluded: false });

    const failed = (await call(admin, 'GET', `/admin/seasons/${monthlyId}`)).json();
    expect(failed).toMatchObject({ status: 'FAILED', error: 'Error: valkey down', ranking: [] });
    const missing = await call(admin, 'GET', `/admin/seasons/${newId()}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('ADMIN_SEASON_NOT_FOUND');
  });

  it('제외하면 모든 범위의 순위를 다시 매기고, 전체 교체라 빠진 사용자는 마감 때 순위로 돌아온다', async () => {
    const res = await call(admin, 'PUT', `/admin/seasons/${weeklyId}/exclusions`, {
      userIds: [s1.userId, s3.userId, s1.userId],
      reason: '부정 학습',
    });
    expect(res.statusCode).toBe(204);
    for (const scope of ['school', CLASS_SCOPE]) {
      expect(await ranksOf(weeklyId, scope)).toEqual([
        [s1.userId, null],
        [hidden.userId, 1],
        [s2.userId, 1],
        [s3.userId, null],
        [s4.userId, 2],
      ]);
    }
    const detail = (await call(admin, 'GET', `/admin/seasons/${weeklyId}`)).json();
    expect(detail.ranking[0]).toMatchObject({ rank: null, excluded: true });
    expect(detail.exclusions).toHaveLength(2);
    expect(detail.exclusions[0]).toMatchObject({
      reason: '부정 학습',
      adminName: expect.any(String),
    });

    await call(admin, 'PUT', `/admin/seasons/${weeklyId}/exclusions`, {
      userIds: [s3.userId],
      reason: '다시 검토',
    });
    expect(await ranksOf(weeklyId, 'school')).toEqual([
      [s1.userId, 1],
      [hidden.userId, 2],
      [s2.userId, 2],
      [s3.userId, null],
      [s4.userId, 3],
    ]);
    const after = (await call(admin, 'GET', `/admin/seasons/${weeklyId}`)).json();
    // 계속 제외되는 사용자는 처음 사유를 그대로 둔다
    expect(after.exclusions).toEqual([
      expect.objectContaining({
        user: expect.objectContaining({ userId: s3.userId }),
        reason: '부정 학습',
      }),
    ]);

    const logs = await db
      .select({ detail: auditLogs.detail })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.actorId, admin.userId),
          eq(auditLogs.action, 'SEASON_EXCLUSIONS_UPDATE'),
          eq(auditLogs.targetId, weeklyId),
        ),
      )
      .orderBy(asc(auditLogs.id));
    expect(logs).toHaveLength(2);
    expect(logs[1]?.detail).toMatchObject({ added: [], removed: [s1.userId], reason: '다시 검토' });
  });

  it('제외 대상 검증: 사유 필수, 없는 사용자·시즌', async () => {
    const url = `/admin/seasons/${weeklyId}/exclusions`;
    expect((await call(admin, 'PUT', url, { userIds: [s2.userId] })).statusCode).toBe(400);
    expect((await call(admin, 'PUT', url, { userIds: [s2.userId], reason: '  ' })).statusCode).toBe(
      400,
    );
    const unknown = await call(admin, 'PUT', url, { userIds: [newId()], reason: '사유' });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().code).toBe('USER_NOT_FOUND');
    const missing = await call(admin, 'PUT', `/admin/seasons/${newId()}/exclusions`, {
      userIds: [],
      reason: '사유',
    });
    expect(missing.json().code).toBe('ADMIN_SEASON_NOT_FOUND');
    expect(await ranksOf(weeklyId, 'school')).toHaveLength(5);
  });

  it('다시 실행은 실패한 시즌만', async () => {
    const confirmed = await call(admin, 'POST', `/admin/seasons/${weeklyId}/rerun`);
    expect(confirmed.statusCode).toBe(409);
    expect(confirmed.json().code).toBe('ADMIN_SEASON_NOT_FAILED');
    expect((await call(admin, 'POST', `/admin/seasons/${newId()}/rerun`)).statusCode).toBe(404);
  });

  it('실패한 시즌을 다시 마감하면 저장된 제외 대상을 반영해 스냅샷을 만든다', async () => {
    const at = new Date('2001-02-10T00:00:00Z');
    for (const key of MONTH_KEYS) {
      await valkey.zadd(
        key,
        encodeScore(50, at),
        s1.userId,
        encodeScore(40, at),
        s2.userId,
        encodeScore(30, at),
        s4.userId,
        encodeScore(80, at),
        admin.userId,
      );
    }
    expect(
      (
        await call(admin, 'PUT', `/admin/seasons/${monthlyId}/exclusions`, {
          userIds: [s2.userId],
          reason: '부정 학습',
        })
      ).statusCode,
    ).toBe(204);

    const res = await call(admin, 'POST', `/admin/seasons/${monthlyId}/rerun`);
    expect(res.statusCode).toBe(202);
    expect(res.json().seasonId).toBe(monthlyId);
    await expect
      .poll(
        async () =>
          (await db.select().from(rankingSeasons).where(eq(rankingSeasons.id, monthlyId)))[0],
        { timeout: 10_000 },
      )
      .toMatchObject({ status: 'CONFIRMED', lastError: null, attempts: 3 });
    // 교사는 넣지 않고, 제외된 사용자는 순위 없이 남는다
    for (const scope of ['school', CLASS_SCOPE]) {
      expect(await ranksOf(monthlyId, scope)).toEqual([
        [s1.userId, 1],
        [s2.userId, null],
        [s4.userId, 2],
      ]);
    }
    const [log] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'SEASON_RERUN'), eq(auditLogs.targetId, monthlyId)));
    expect(log).toMatchObject({ actorId: admin.userId });
  });

  it('관리자만 쓸 수 있다', async () => {
    expect((await call(s1, 'GET', '/admin/seasons')).statusCode).toBe(403);
  });
});
