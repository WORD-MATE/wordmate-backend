import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { kstDate } from '../src/common/time/kst.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  dailyStudiedWords,
  dailyStudyStats,
  packs,
  studyRecordItems,
  studyRecords,
  studySessions,
  userStreaks,
  users,
  userWordProgress,
  words,
  wrongNotes,
  xpLedger,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { createTestApp, inject } from './support/create-test-app.js';

type Question = { index: number; wordId: string; answerIndex: number | null };

describe('학습 종료', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];
  const today = kstDate();

  const makeUser = async (): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    await db
      .insert(users)
      .values({ id: userId, name: '종료유저', role: 'STUDENT', grade: 3, classNo: 1 });
    return { userId, role: 'STUDENT', isAdmin: false, deviceId: newId() };
  };

  const call = async (
    user: AuthUser,
    method: 'GET' | 'POST' | 'DELETE',
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

  const createPack = async (user: AuthUser, count = 4) => {
    const packId = (
      await call(user, 'POST', '/packs', { name: `종료 ${newId().slice(-8)}` })
    ).json().packId as string;
    await call(user, 'POST', `/packs/${packId}/words`, {
      words: Array.from({ length: count }, (_, i) => ({
        english: `word${i}`,
        meanings: [`뜻${i}`],
      })),
    });
    return packId;
  };

  const start = async (user: AuthUser, packId: string, mode = 'CHOICE', extra: object = {}) => {
    const res = await call(user, 'POST', '/study/sessions', {
      source: 'PACK',
      packId,
      mode,
      direction: 'EN_TO_KO',
      shuffle: false,
      force: true,
      ...extra,
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { sessionId: string; questions: Question[] };
  };

  const answer = (user: AuthUser, sessionId: string, body: object) =>
    call(user, 'POST', `/study/sessions/${sessionId}/answers`, { elapsedMs: 2000, ...body });

  /** CHOICE 문항을 앞에서부터 답한다. wrong에 든 index는 틀리게 */
  const answerChoices = async (
    user: AuthUser,
    session: { sessionId: string; questions: Question[] },
    count: number,
    wrong: number[] = [],
  ) => {
    for (const q of session.questions.slice(0, count)) {
      const right = q.answerIndex as number;
      await answer(user, session.sessionId, {
        index: q.index,
        choiceIndex: wrong.includes(q.index) ? (right + 1) % 4 : right,
      });
    }
  };

  const complete = (user: AuthUser, sessionId: string, reason = 'FINISHED', key?: string) =>
    call(
      user,
      'POST',
      `/study/sessions/${sessionId}/complete`,
      { reason },
      key ? { 'idempotency-key': key } : {},
    );

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
  });

  afterAll(async () => {
    await db.delete(studyRecords).where(inArray(studyRecords.userId, userIds));
    await db.delete(studySessions).where(inArray(studySessions.userId, userIds));
    for (const table of [wrongNotes, userWordProgress, dailyStudyStats, dailyStudiedWords]) {
      await db.delete(table).where(inArray(table.userId, userIds));
    }
    await db.delete(userStreaks).where(inArray(userStreaks.userId, userIds));
    await db.delete(xpLedger).where(inArray(xpLedger.userId, userIds));
    const owned = await db
      .select({ id: packs.id })
      .from(packs)
      .where(inArray(packs.ownerUserId, userIds));
    const ids = owned.map((row) => row.id);
    if (ids.length > 0) {
      await db.delete(words).where(inArray(words.packId, ids));
      await db.delete(packs).where(inArray(packs.id, ids));
    }
    await app.close();
  });

  it('팩 완주: 정답 XP + 완주 보너스, 기록·일별 통계·스트릭, 다시 끝내면 409', async () => {
    const user = await makeUser();
    const packId = await createPack(user);
    const session = await start(user, packId);
    await answerChoices(user, session, 4, [3]);

    const key = randomUUID();
    const res = await complete(user, session.sessionId, 'FINISHED', key);
    expect(res.statusCode).toBe(200);
    const result = res.json();
    expect(result).toMatchObject({
      correctCount: 3,
      wrongCount: 1,
      accuracy: 75,
      knownCount: null,
      unknownCount: null,
      xp: { earned: 13, blockedReason: null, todayTotal: 13 },
      packCompleteBonus: true,
      streak: { current: 1, increased: true },
    });

    const replay = await complete(user, session.sessionId, 'FINISHED', key);
    expect(replay.json()).toEqual(result);
    expect((await complete(user, session.sessionId)).json().code).toBe('STUDY_SESSION_CLOSED');
    expect((await answer(user, session.sessionId, { index: 0, choiceIndex: 0 })).statusCode).toBe(
      409,
    );
    expect((await call(user, 'DELETE', `/study/sessions/${session.sessionId}`)).statusCode).toBe(
      409,
    );
    expect((await call(user, 'GET', '/study/sessions/current')).json()).toBeNull();
    expect((await call(user, 'GET', `/study/sessions/${session.sessionId}`)).json().status).toBe(
      'COMPLETED',
    );

    const [record] = await db
      .select()
      .from(studyRecords)
      .where(eq(studyRecords.id, result.recordId));
    expect(record).toMatchObject({
      packId,
      reason: 'FINISHED',
      xpEarned: 13,
      packCompleteBonus: true,
      accuracy: 75,
      completedDate: today,
    });
    const items = await db
      .select()
      .from(studyRecordItems)
      .where(eq(studyRecordItems.recordId, result.recordId));
    expect(items.map((i) => [i.english, i.correct])).toEqual([
      ['word0', true],
      ['word1', true],
      ['word2', true],
      ['word3', false],
    ]);
    const [stats] = await db
      .select()
      .from(dailyStudyStats)
      .where(eq(dailyStudyStats.userId, user.userId));
    expect(stats).toMatchObject({
      date: today,
      solvedCount: 4,
      gradedCount: 4,
      correctCount: 3,
      sessionsCompleted: 1,
      xpStudy: 13,
    });
    const studied = await db
      .select()
      .from(dailyStudiedWords)
      .where(eq(dailyStudiedWords.userId, user.userId));
    expect(studied).toHaveLength(4);
  });

  it('같은 팩 완주 보너스는 하루 1회 (REPEAT_LIMIT), 스트릭은 같은 날 그대로', async () => {
    const user = await makeUser();
    const packId = await createPack(user);
    const first = await start(user, packId);
    await answerChoices(user, first, 4);
    expect((await complete(user, first.sessionId)).json().packCompleteBonus).toBe(true);

    const second = await start(user, packId);
    await answerChoices(user, second, 4);
    expect((await complete(user, second.sessionId)).json()).toMatchObject({
      xp: { earned: 4, blockedReason: 'REPEAT_LIMIT', todayTotal: 18 },
      packCompleteBonus: false,
      streak: { current: 1, increased: false },
    });
  });

  it('그만두기·일부만 출제·직접 입력·너무 빠른 답', async () => {
    const user = await makeUser();
    const packId = await createPack(user, 12);

    const typing = await start(user, packId, 'TYPING');
    await answer(user, typing.sessionId, { index: 0, typedAnswer: '뜻0' });
    await answer(user, typing.sessionId, { index: 1, typedAnswer: '뜻1', elapsedMs: 100 });
    await answer(user, typing.sessionId, { index: 2, typedAnswer: '틀림' });
    expect((await complete(user, typing.sessionId, 'QUIT')).json()).toMatchObject({
      correctCount: 2,
      wrongCount: 1,
      xp: { earned: 2, blockedReason: 'TOO_FAST' },
      packCompleteBonus: false,
    });

    const quit = await start(user, packId);
    await answerChoices(user, quit, 2);
    expect((await complete(user, quit.sessionId, 'QUIT')).json().xp).toMatchObject({
      earned: 2,
      blockedReason: 'NOT_COMPLETED',
    });

    // 10문제만 내면 팩 전체가 아니라 완주가 아니다
    const partial = await start(user, packId, 'CHOICE', { questionCount: 10 });
    await answerChoices(user, partial, 10);
    expect((await complete(user, partial.sessionId)).json()).toMatchObject({
      xp: { earned: 10, blockedReason: null },
      packCompleteBonus: false,
    });
  });

  it('플래시카드는 알아요·몰라요 수, XP 없음. 답이 없으면 스트릭 null', async () => {
    const user = await makeUser();
    const packId = await createPack(user);
    const flash = await start(user, packId, 'FLASHCARD');
    await answer(user, flash.sessionId, { index: 0, known: true });
    await answer(user, flash.sessionId, { index: 1, known: false });
    expect((await complete(user, flash.sessionId)).json()).toMatchObject({
      correctCount: 0,
      wrongCount: 0,
      accuracy: null,
      knownCount: 1,
      unknownCount: 1,
      xp: { earned: 0, blockedReason: null, todayTotal: 0 },
      packCompleteBonus: false,
      streak: { current: 1, increased: true },
    });

    const other = await makeUser();
    const otherPack = await createPack(other);
    const empty = await start(other, otherPack);
    const res = (await complete(other, empty.sessionId, 'QUIT')).json();
    expect(res).toMatchObject({ correctCount: 0, accuracy: null, streak: null });
    expect(
      (await db.select().from(userStreaks).where(eq(userStreaks.userId, other.userId))).length,
    ).toBe(0);
  });

  it('하루 XP 상한 500을 넘으면 잘라서 주고 DAILY_CAP', async () => {
    const user = await makeUser();
    await db.insert(xpLedger).values({
      id: newId(),
      userId: user.userId,
      source: 'BATTLE',
      refKey: 'test:cap',
      amount: 495,
      date: today,
    });
    const packId = await createPack(user);
    const session = await start(user, packId);
    await answerChoices(user, session, 4);
    expect((await complete(user, session.sessionId)).json()).toMatchObject({
      xp: { earned: 5, blockedReason: 'DAILY_CAP', todayTotal: 500 },
      // 보너스는 상한까지 남은 1만 받았지만 완주는 인정
      packCompleteBonus: true,
    });
    const ledger = await db
      .select({ source: xpLedger.source, amount: xpLedger.amount, blocked: xpLedger.blockedReason })
      .from(xpLedger)
      .where(and(eq(xpLedger.userId, user.userId), eq(xpLedger.date, today)));
    expect(ledger).toEqual(
      expect.arrayContaining([
        { source: 'STUDY', amount: 4, blocked: null },
        { source: 'PACK_COMPLETE', amount: 1, blocked: 'DAILY_CAP' },
      ]),
    );
  });

  it('어제 학습했으면 스트릭이 이어지고, 하루 이상 비면 1부터', async () => {
    const user = await makeUser();
    const yesterday = Temporal.PlainDate.from(today).subtract({ days: 1 }).toString();
    await db
      .insert(userStreaks)
      .values({ userId: user.userId, kind: 'STUDY', current: 3, best: 5, lastDate: yesterday });
    const packId = await createPack(user);
    const session = await start(user, packId);
    await answerChoices(user, session, 1);
    expect((await complete(user, session.sessionId, 'QUIT')).json().streak).toEqual({
      current: 4,
      increased: true,
    });

    const lapsed = await makeUser();
    const lapsedDay = Temporal.PlainDate.from(today).subtract({ days: 3 }).toString();
    await db
      .insert(userStreaks)
      .values({ userId: lapsed.userId, kind: 'STUDY', current: 7, best: 7, lastDate: lapsedDay });
    const lapsedPack = await createPack(lapsed);
    const s = await start(lapsed, lapsedPack);
    await answerChoices(lapsed, s, 1);
    await complete(lapsed, s.sessionId, 'QUIT');
    const [streak] = await db
      .select()
      .from(userStreaks)
      .where(eq(userStreaks.userId, lapsed.userId));
    expect(streak).toMatchObject({ current: 1, best: 7, lastDate: today });
  });
});
