import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inArray, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { kstDayRange } from '../src/common/time/kst.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  auditLogs,
  battleDailyPairs,
  type NewUser,
  studyAnswers,
  studySessions,
  suspiciousFlags,
  users,
  xpLedger,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { SuspiciousService } from '../src/modules/suspicious/suspicious.service.js';
import {
  FAST_ANSWER_MIN_COUNT,
  REPEATED_OPPONENT_MIN,
  XP_SPIKE_CAP_DAYS,
} from '../src/modules/suspicious/suspicious-rules.js';
import { DAILY_XP_CAP } from '../src/modules/xp/xp.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

// 다른 테스트와 겹치지 않는 지난 날짜
const DATE = '2020-03-15';

type Item = {
  user: { userId: string };
  date: string;
  reasons: string[];
  detail: Record<string, Record<string, unknown>>;
  reviewed: boolean;
};

describe('관리자 부정 의심 사용자', () => {
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
      name: `의심${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 2 : null,
      classNo: role === 'STUDENT' ? 3 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (user: AuthUser, method: 'GET' | 'PATCH', url: string, payload?: object) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  /** 그날 답 total개 중 fast개는 너무 빠른 답 */
  const answer = async (user: AuthUser, total: number, fast: number) => {
    const sessionId = newId();
    const { start } = kstDayRange(DATE);
    await db.insert(studySessions).values({
      id: sessionId,
      userId: user.userId,
      source: 'FAVORITE',
      mode: 'CHOICE',
      direction: 'EN_TO_KO',
      shuffle: false,
      status: 'COMPLETED',
      total,
      answeredCount: total,
      expiresAt: start,
    });
    await db.insert(studyAnswers).values(
      Array.from({ length: total }, (_, idx) => ({
        sessionId,
        idx,
        choiceIndex: 0,
        correct: true,
        counted: idx >= fast,
        elapsedMs: idx < fast ? 100 : 2000,
        submittedAt: new Date(start.getTime() + 60_000 + idx * 1000),
      })),
    );
  };

  const battle = (a: AuthUser, b: AuthUser, count: number) =>
    db.insert(battleDailyPairs).values([
      { date: DATE, userId: a.userId, opponentId: b.userId, count },
      { date: DATE, userId: b.userId, opponentId: a.userId, count },
    ]);

  /** DATE까지 days일 연속으로 하루 상한만큼 받았다 */
  const capDays = (user: AuthUser, days: number) =>
    db.insert(xpLedger).values(
      Array.from({ length: days }, (_, i) => {
        const date = Temporal.PlainDate.from(DATE).subtract({ days: i }).toString();
        return {
          id: newId(),
          userId: user.userId,
          source: 'STUDY' as const,
          refKey: `suspicious-test:${date}`,
          amount: DAILY_XP_CAP,
          date,
        };
      }),
    );

  const listOf = async (query: string) =>
    (await call(admin, 'GET', `/admin/suspicious-users?from=${DATE}&to=${DATE}&size=100${query}`))
      .json()
      .items.filter((i: Item) => userIds.includes(i.user.userId)) as Item[];

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    admin = await makeUser({ role: 'TEACHER', isAdmin: true });
  });

  afterAll(async () => {
    await db.delete(suspiciousFlags).where(inArray(suspiciousFlags.userId, userIds));
    await db.delete(studySessions).where(inArray(studySessions.userId, userIds));
    await db
      .delete(battleDailyPairs)
      .where(
        or(
          inArray(battleDailyPairs.userId, userIds),
          inArray(battleDailyPairs.opponentId, userIds),
        ),
      );
    await db.delete(xpLedger).where(inArray(xpLedger.userId, userIds));
    await db.delete(auditLogs).where(inArray(auditLogs.actorId, userIds));
    await app.close();
  });

  it('기준을 넘은 활동만 표시하고, 같은 날을 다시 돌려도 한 번만 남는다', async () => {
    const [cheater, honest, rival, friend, buddy, grinder, steady] = await Promise.all([
      makeUser(),
      makeUser(),
      makeUser(),
      makeUser(),
      makeUser(),
      makeUser(),
      makeUser(),
    ]);
    await answer(cheater, FAST_ANSWER_MIN_COUNT, FAST_ANSWER_MIN_COUNT);
    await answer(honest, FAST_ANSWER_MIN_COUNT, 2);
    await battle(cheater, rival, REPEATED_OPPONENT_MIN);
    await battle(friend, buddy, REPEATED_OPPONENT_MIN - 1);
    await capDays(grinder, XP_SPIKE_CAP_DAYS);
    await capDays(steady, XP_SPIKE_CAP_DAYS - 1);

    const service = app.get(SuspiciousService);
    const first = await service.detect(DATE);
    expect(first.flagged).toBeGreaterThanOrEqual(4);
    expect((await service.detect(DATE)).flagged).toBe(0);

    const items = await listOf('');
    const byUser = new Map(items.map((i) => [i.user.userId, i]));
    expect(byUser.get(cheater.userId)).toMatchObject({
      date: DATE,
      reasons: ['FAST_ANSWERS', 'REPEATED_OPPONENT'],
      reviewed: false,
      detail: {
        FAST_ANSWERS: { answerCount: FAST_ANSWER_MIN_COUNT, fastCount: FAST_ANSWER_MIN_COUNT },
        REPEATED_OPPONENT: {
          opponents: [{ userId: rival.userId, battleCount: REPEATED_OPPONENT_MIN }],
        },
      },
    });
    expect(byUser.get(rival.userId)?.reasons).toEqual(['REPEATED_OPPONENT']);
    expect(byUser.get(grinder.userId)).toMatchObject({
      reasons: ['XP_SPIKE'],
      detail: { XP_SPIKE: { capDays: XP_SPIKE_CAP_DAYS } },
    });
    for (const user of [honest, friend, buddy, steady]) {
      expect(byUser.has(user.userId)).toBe(false);
    }

    const xpOnly = await listOf('&reason=XP_SPIKE');
    expect(xpOnly.map((i) => i.user.userId)).toEqual([grinder.userId]);
  });

  it('확인 처리하면 그날 표시가 모두 확인됨으로 바뀌고 감사 로그가 남는다', async () => {
    const [target] = await listOf('&reviewed=false');
    if (!target) throw new Error('표시가 없습니다');
    const url = `/admin/suspicious-users/${target.user.userId}/${DATE}`;

    expect((await call(admin, 'PATCH', url, { reviewed: true })).statusCode).toBe(204);
    const reviewed = await listOf('&reviewed=true');
    expect(reviewed.map((i) => i.user.userId)).toContain(target.user.userId);
    expect((await listOf('&reviewed=false')).map((i) => i.user.userId)).not.toContain(
      target.user.userId,
    );
    const logs = await db
      .select()
      .from(auditLogs)
      .where(inArray(auditLogs.actorId, [admin.userId]));
    expect(logs.some((l) => l.action === 'SUSPICIOUS_REVIEW')).toBe(true);

    const missing = await call(admin, 'PATCH', `/admin/suspicious-users/${newId()}/${DATE}`, {
      reviewed: true,
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('SUSPICIOUS_NOT_FOUND');
  });

  it('관리자가 아니면 볼 수 없다', async () => {
    const student = await makeUser();
    expect((await call(student, 'GET', '/admin/suspicious-users')).statusCode).toBe(403);
  });
});
