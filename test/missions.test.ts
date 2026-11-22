import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  missions,
  morningSentences,
  type NewUser,
  userMissions,
  users,
  xpLedger,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { periodKeyOf } from '../src/modules/missions/mission-progress.js';
import { MORNING_XP, morningDate } from '../src/modules/morning/morning-rules.js';
import { applyMorningSeed } from '../src/modules/morning/seed/morning-seed.js';
import { createTestApp, inject } from './support/create-test-app.js';

type Mission = { missionId: string; title: string; progress: number; status: string };

describe('미션', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];
  const today = morningDate();

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `미션${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 4 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (user: AuthUser, method: 'GET' | 'POST', url: string, payload?: object) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const missionsOf = async (user: AuthUser) => (await call(user, 'GET', '/missions')).json();
  const idOf = async (code: string) =>
    ((await db.select().from(missions).where(eq(missions.code, code)))[0] as { id: string }).id;
  const claim = async (user: AuthUser, code: string) =>
    call(user, 'POST', `/missions/${await idOf(code)}/claim`);

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    await applyMorningSeed(db, {
      sentences: [
        {
          date: today,
          sentence: 'Small steps every day.',
          translation: '매일 작은 걸음.',
          keywords: [{ english: 'step', meanings: ['걸음'], highlight: { start: 6, end: 11 } }],
          quizzes: [{ type: 'FILL_BLANK', question: 'Small _____ every day.', answers: ['steps'] }],
        },
      ],
    });
  });

  afterAll(async () => {
    await db.delete(morningSentences).where(eq(morningSentences.publishDate, today));
    await db.delete(xpLedger).where(inArray(xpLedger.userId, userIds));
    await app.close();
  });

  it('이번 기간 미션을 일일·주간으로 보여 준다', async () => {
    const user = await makeUser();
    const res = await call(user, 'GET', '/missions');
    expect(res.statusCode).toBe(200);
    const { daily, weekly } = res.json();
    expect(daily.map((m: Mission) => m.title)).toEqual([
      '학습 1회 끝내기',
      '단어 20개 학습하기',
      '대결 1번 끝까지 하기',
      '오늘의 문장 퀴즈 풀기',
    ]);
    expect(weekly).toHaveLength(3);
    expect([...daily, ...weekly].every((m: Mission) => m.progress === 0)).toBe(true);
    expect([...daily, ...weekly].every((m: Mission) => m.status === 'IN_PROGRESS')).toBe(true);
    expect(new Date(daily[0].expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(new Date(weekly[0].expiresAt).getTime()).toBeGreaterThanOrEqual(
      new Date(daily[0].expiresAt).getTime(),
    );
  });

  it('활동으로 채운 미션은 한 번 보상을 받고, 미션 보상은 XP 미션에 세지 않는다', async () => {
    const user = await makeUser();
    await call(user, 'POST', `/morning/${today}/quiz/complete`, {
      answers: [{ index: 0, answer: 'steps' }],
    });
    const before = await missionsOf(user);
    const morning = before.daily.find((m: Mission) => m.title === '오늘의 문장 퀴즈 풀기');
    expect(morning).toMatchObject({ progress: 1, target: 1, status: 'CLAIMABLE', rewardXp: 5 });
    expect(before.weekly.find((m: Mission) => m.title === 'XP 300 모으기').progress).toBe(
      MORNING_XP,
    );

    const res = await claim(user, 'DAILY_MORNING');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      xp: { earned: 5, blockedReason: null, todayTotal: MORNING_XP + 5 },
    });
    expect((await claim(user, 'DAILY_MORNING')).json().code).toBe('MISSION_ALREADY_CLAIMED');
    expect((await claim(user, 'DAILY_STUDY')).json().code).toBe('MISSION_NOT_CLAIMABLE');
    expect((await call(user, 'POST', `/missions/${newId()}/claim`)).json().code).toBe(
      'MISSION_NOT_FOUND',
    );

    const after = await missionsOf(user);
    expect(after.daily.find((m: Mission) => m.title === '오늘의 문장 퀴즈 풀기').status).toBe(
      'CLAIMED',
    );
    expect(after.weekly.find((m: Mission) => m.title === 'XP 300 모으기').progress).toBe(
      MORNING_XP,
    );
    const [row] = await db
      .select({ totalXp: users.totalXp })
      .from(users)
      .where(eq(users.id, user.userId));
    expect(row?.totalXp).toBe(MORNING_XP + 5);

    const home = (await call(user, 'GET', '/home')).json();
    expect(home.missions).toHaveLength(4);
    expect(home.missions[3]).toMatchObject({ title: '오늘의 문장 퀴즈 풀기', status: 'CLAIMED' });
  });

  it('동시에 받아도 한 번만 지급하고, 지난 기간 진행은 새 기간에 이어지지 않는다', async () => {
    const user = await makeUser();
    const missionId = await idOf('WEEKLY_STUDY');
    const lastWeek = Temporal.PlainDate.from(periodKeyOf('WEEKLY', new Date()))
      .subtract({ weeks: 1 })
      .toString();
    await db.insert(userMissions).values([
      { userId: user.userId, missionId, periodKey: lastWeek, progress: 5 },
      {
        userId: user.userId,
        missionId,
        periodKey: periodKeyOf('WEEKLY', new Date()),
        progress: 5,
      },
    ]);
    const results = await Promise.all([
      claim(user, 'WEEKLY_STUDY'),
      claim(user, 'WEEKLY_STUDY'),
      claim(user, 'WEEKLY_STUDY'),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409, 409]);
    const ledger = await db.select().from(xpLedger).where(eq(xpLedger.userId, user.userId));
    expect(ledger.map((l) => l.amount)).toEqual([30]);

    await db.delete(userMissions).where(eq(userMissions.userId, user.userId));
    await db
      .insert(userMissions)
      .values({ userId: user.userId, missionId, periodKey: lastWeek, progress: 5 });
    const weekly = (await missionsOf(user)).weekly.find((m: Mission) => m.missionId === missionId);
    expect(weekly).toMatchObject({ progress: 0, status: 'IN_PROGRESS' });
  });

  it('교사는 미션이 없다', async () => {
    const teacher = await makeUser({ role: 'TEACHER', isAdmin: true });
    expect((await call(teacher, 'GET', '/missions')).statusCode).toBe(403);
    expect((await call(teacher, 'GET', '/home')).json().missions).toBeNull();
  });
});
