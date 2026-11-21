import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { kstDate } from '../src/common/time/kst.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  challengeAttempts,
  dailyChallenges,
  type NewUser,
  packs,
  users,
  words,
  xpLedger,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { ChallengeProcessor } from '../src/modules/challenges/challenge.processor.js';
import { createTestApp, inject } from './support/create-test-app.js';

type Question = { index: number; prompt: string; choices: string[] };

describe('오늘의 챌린지', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let packId: string;
  const today = kstDate();
  const tomorrow = kstDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
  const userIds: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `챌린지${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 3 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (
    user: AuthUser,
    method: 'GET' | 'POST',
    url: string,
    payload?: object,
    headers: Record<string, string> = {},
  ) =>
    inject(app, {
      method,
      url,
      payload,
      headers: {
        authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}`,
        ...headers,
      },
    });

  const complete = (user: AuthUser, attemptId: string, answers: object[], key = newId()) =>
    call(
      user,
      'POST',
      `/challenges/today/attempt/${attemptId}/complete`,
      { answers },
      { 'idempotency-key': key },
    );

  const todaysQuestions = async () =>
    (await db.select().from(dailyChallenges).where(eq(dailyChallenges.date, today)))[0]
      ?.questions ?? [];

  const clearChallenges = async () => {
    await db.delete(challengeAttempts).where(inArray(challengeAttempts.date, [today, tomorrow]));
    await db.delete(dailyChallenges).where(inArray(dailyChallenges.date, [today, tomorrow]));
  };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    await clearChallenges();
    const admin = await makeUser({ role: 'TEACHER', isAdmin: true });
    packId = (
      await call(admin, 'POST', '/packs', {
        name: `챌린지팩 ${newId().slice(-6)}`,
        type: 'DEFAULT',
      })
    ).json().packId;
    await call(admin, 'POST', `/packs/${packId}/words`, {
      words: Array.from({ length: 12 }, (_, i) => ({
        english: `challenge${i}`,
        meanings: [`도전${i}`],
      })),
    });
  });

  afterAll(async () => {
    await clearChallenges();
    await db.delete(xpLedger).where(inArray(xpLedger.userId, userIds));
    await db.delete(words).where(eq(words.packId, packId));
    await db.delete(packs).where(eq(packs.id, packId));
    await app.close();
  });

  it('오늘의 챌린지: 처음 조회할 때 문제를 만들고, 교사는 403', async () => {
    const student = await makeUser();
    const res = await call(student, 'GET', '/challenges/today');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      date: today,
      questionCount: 10,
      timeLimitSec: 10,
      participated: false,
      myResult: null,
    });
    expect(await todaysQuestions()).toHaveLength(10);
    const teacher = await makeUser({ role: 'TEACHER', isAdmin: true });
    expect((await call(teacher, 'GET', '/challenges/today')).statusCode).toBe(403);
  });

  it('시작하면 정답 없이 모두 같은 문제, 하루 한 번', async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    const res = await call(a, 'POST', '/challenges/today/attempt');
    expect(res.statusCode).toBe(201);
    const { attemptId, questions } = res.json() as { attemptId: string; questions: Question[] };
    expect(questions).toHaveLength(10);
    expect(questions.every((q) => !('answerIndex' in q) && q.choices.length === 4)).toBe(true);
    const other = (await call(b, 'POST', '/challenges/today/attempt')).json();
    expect(other.questions).toEqual(questions);

    const again = (await call(a, 'POST', '/challenges/today/attempt')).json();
    expect(again).toMatchObject({ code: 'CHALLENGE_IN_PROGRESS', detail: { attemptId } });
    expect((await call(a, 'GET', '/challenges/today')).json()).toMatchObject({
      participated: true,
      myResult: null,
    });
  });

  it('끝내면 채점·XP, 같은 키는 같은 응답, 다시 끝내거나 다시 시작하면 409', async () => {
    const student = await makeUser();
    const { attemptId } = (await call(student, 'POST', '/challenges/today/attempt')).json();
    const stored = await todaysQuestions();
    const answerOf = (i: number) => stored[i]?.answerIndex as number;
    const answers = [
      ...[0, 1, 2, 3, 4, 5].map((i) => ({
        index: i,
        choiceIndex: answerOf(i),
        elapsedMs: 2000,
      })),
      { index: 6, choiceIndex: (answerOf(6) + 1) % 4, elapsedMs: 2000 },
      { index: 7, choiceIndex: null, elapsedMs: 10_000 },
      { index: 8, choiceIndex: answerOf(8), elapsedMs: 10_001 },
    ];

    const noKey = await call(student, 'POST', `/challenges/today/attempt/${attemptId}/complete`, {
      answers,
    });
    expect(noKey.statusCode).toBe(400);
    expect((await complete(await makeUser(), attemptId, answers)).json().code).toBe(
      'CHALLENGE_ATTEMPT_NOT_FOUND',
    );

    const key = newId();
    const res = await complete(student, attemptId, answers, key);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      score: 6 * 140,
      correctCount: 6,
      total: 10,
      xp: { earned: 18, blockedReason: null },
    });
    expect(body.xp.todayTotal).toBeGreaterThanOrEqual(18);
    expect(body.results).toHaveLength(10);
    expect(body.results[0]).toEqual({ index: 0, correct: true, answerIndex: answerOf(0) });
    expect(body.results[8]).toEqual({ index: 8, correct: false, answerIndex: answerOf(8) });

    const replay = await complete(student, attemptId, answers, key);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.json()).toEqual(body);
    expect((await complete(student, attemptId, answers)).json().code).toBe(
      'CHALLENGE_ALREADY_DONE',
    );
    expect((await call(student, 'POST', '/challenges/today/attempt')).json().code).toBe(
      'CHALLENGE_ALREADY_DONE',
    );
    expect((await call(student, 'GET', '/challenges/today')).json().myResult).toEqual({
      score: 840,
      correctCount: 6,
      xp: 18,
    });
    expect(
      await db
        .select({ refKey: xpLedger.refKey, amount: xpLedger.amount })
        .from(xpLedger)
        .where(and(eq(xpLedger.userId, student.userId), eq(xpLedger.source, 'CHALLENGE'))),
    ).toEqual([{ refKey: `challenge:${today}`, amount: 18 }]);
  });

  it('시작 시각부터 제한 시간을 모두 쓴 시간이 지나 끝내면 모두 미응답', async () => {
    const student = await makeUser();
    const { attemptId } = (await call(student, 'POST', '/challenges/today/attempt')).json();
    await db
      .update(challengeAttempts)
      .set({ startedAt: new Date(Date.now() - 3 * 60 * 1000) })
      .where(eq(challengeAttempts.id, attemptId));
    const stored = await todaysQuestions();
    const res = await complete(
      student,
      attemptId,
      stored.map((q) => ({ index: q.index, choiceIndex: q.answerIndex, elapsedMs: 1000 })),
    );
    expect(res.json()).toMatchObject({ score: 0, correctCount: 0, xp: { earned: 0 } });
  });

  it('매일 정해진 시각에 다음 날 문제를 미리 만든다', async () => {
    expect(await app.get(ChallengeProcessor).process()).toBe(
      kstDate(new Date(Date.now() + 60 * 60 * 1000)),
    );
    const date = kstDate(new Date(Date.now() + 60 * 60 * 1000));
    expect(
      await db.select().from(dailyChallenges).where(eq(dailyChallenges.date, date)),
    ).toHaveLength(1);
  });
});
