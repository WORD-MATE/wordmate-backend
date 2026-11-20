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

describe('간격 반복 복습', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];
  const today = kstDate();
  const shift = (days: number) => Temporal.PlainDate.from(today).add({ days }).toString();

  const makeUser = async (): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    await db
      .insert(users)
      .values({ id: userId, name: '복습유저', role: 'STUDENT', grade: 2, classNo: 2 });
    return { userId, role: 'STUDENT', isAdmin: false, deviceId: newId() };
  };

  const call = async (
    user: AuthUser,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const createPack = async (user: AuthUser, count: number) => {
    const packId = (
      await call(user, 'POST', '/packs', { name: `복습 ${newId().slice(-8)}` })
    ).json().packId as string;
    await call(user, 'POST', `/packs/${packId}/words`, {
      words: Array.from({ length: count }, (_, i) => ({
        english: `word${i}`,
        meanings: [`뜻${i}`],
      })),
    });
    return packId;
  };

  /** wrongWords에 든 단어는 틀리게 답하고 끝낸다 */
  const play = async (user: AuthUser, body: object, wrongWords: string[] = []) => {
    const res = await call(user, 'POST', '/study/sessions', {
      mode: 'CHOICE',
      direction: 'EN_TO_KO',
      shuffle: false,
      force: true,
      ...body,
    });
    expect(res.statusCode).toBe(201);
    const { sessionId, questions, mode } = res.json() as {
      sessionId: string;
      questions: Question[];
      mode: string;
    };
    for (const q of questions) {
      const miss = wrongWords.includes(q.wordId);
      await call(user, 'POST', `/study/sessions/${sessionId}/answers`, {
        index: q.index,
        elapsedMs: 2000,
        ...(mode === 'FLASHCARD'
          ? { known: !miss }
          : { choiceIndex: miss ? ((q.answerIndex as number) + 1) % 4 : q.answerIndex }),
      });
    }
    const done = await call(user, 'POST', `/study/sessions/${sessionId}/complete`, {
      reason: 'FINISHED',
    });
    return { questions, result: done.json() as { xp: { earned: number } } };
  };

  const summary = async (user: AuthUser) => (await call(user, 'GET', '/study/review')).json();
  const progressOf = async (user: AuthUser, wordId: string) =>
    (
      await db
        .select()
        .from(userWordProgress)
        .where(and(eq(userWordProgress.userId, user.userId), eq(userWordProgress.wordId, wordId)))
    )[0];
  const makeDue = (user: AuthUser, on = today) =>
    db
      .update(userWordProgress)
      .set({ nextReviewOn: on })
      .where(eq(userWordProgress.userId, user.userId));

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
  });

  afterAll(async () => {
    await db.delete(studyRecords).where(inArray(studyRecords.userId, userIds));
    await db.delete(studySessions).where(inArray(studySessions.userId, userIds));
    for (const table of [
      wrongNotes,
      userWordProgress,
      dailyStudyStats,
      dailyStudiedWords,
      xpLedger,
    ]) {
      await db.delete(table).where(inArray(table.userId, userIds));
    }
    await db.delete(userStreaks).where(inArray(userStreaks.userId, userIds));
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

  it('처음 공부한 단어는 다음 날 복습, 복습에서 맞히면 다음 간격, 틀리면 다음 날부터 다시', async () => {
    const user = await makeUser();
    const packId = await createPack(user, 4);
    const { questions } = await play(user, { source: 'PACK', packId });
    const [w0, w1] = questions.map((q) => q.wordId) as [string, string];
    expect(await progressOf(user, w0)).toMatchObject({ reviewStage: 0, nextReviewOn: shift(1) });
    expect(await summary(user)).toEqual({ dueCount: 0, completedToday: 0 });
    const early = await call(user, 'POST', '/study/sessions', {
      source: 'REVIEW',
      mode: 'CHOICE',
      direction: 'EN_TO_KO',
      shuffle: false,
    });
    expect(early.json().code).toBe('STUDY_EMPTY');

    await makeDue(user);
    expect(await summary(user)).toEqual({ dueCount: 4, completedToday: 0 });
    const review = await play(user, { source: 'REVIEW' }, [w1]);
    expect(review.questions).toHaveLength(4);
    // 복습 학습도 정답 XP는 그대로 (4지선다 +1)
    expect(review.result.xp.earned).toBe(3);

    expect(await progressOf(user, w0)).toMatchObject({
      reviewStage: 1,
      nextReviewOn: shift(3),
      lastReviewedOn: today,
    });
    expect(await progressOf(user, w1)).toMatchObject({ reviewStage: 0, nextReviewOn: shift(1) });
    expect(await summary(user)).toEqual({ dueCount: 0, completedToday: 4 });

    // 일반 학습에서 맞혀도 일정은 그대로
    await play(user, { source: 'PACK', packId });
    expect(await progressOf(user, w0)).toMatchObject({ reviewStage: 1, nextReviewOn: shift(3) });
    // 일반 학습에서 틀리면 다음 날부터 다시
    await play(user, { source: 'PACK', packId }, [w0]);
    expect(await progressOf(user, w0)).toMatchObject({ reviewStage: 0, nextReviewOn: shift(1) });
  });

  it('하루 최대 30개, 복습일이 이른 순, 지운 단어·팩은 빠진다', async () => {
    const user = await makeUser();
    const packId = await createPack(user, 35);
    const { questions } = await play(user, { source: 'PACK', packId, mode: 'FLASHCARD' });
    await makeDue(user, shift(-1));
    const oldest = questions[34]?.wordId as string;
    await db
      .update(userWordProgress)
      .set({ nextReviewOn: shift(-5) })
      .where(and(eq(userWordProgress.userId, user.userId), eq(userWordProgress.wordId, oldest)));

    expect((await summary(user)).dueCount).toBe(30);
    const started = await call(user, 'POST', '/study/sessions', {
      source: 'REVIEW',
      mode: 'FLASHCARD',
      direction: 'EN_TO_KO',
      shuffle: false,
    });
    expect(started.statusCode).toBe(201);
    const reviewWords = started.json().questions.map((q: Question) => q.wordId);
    expect(reviewWords).toHaveLength(30);
    expect(reviewWords[0]).toBe(oldest);
    expect(started.json().pack).toBeNull();

    await call(user, 'DELETE', `/packs/${packId}/words/${oldest}`);
    const afterDelete = await call(user, 'POST', '/study/sessions', {
      source: 'REVIEW',
      mode: 'FLASHCARD',
      direction: 'EN_TO_KO',
      shuffle: false,
      force: true,
    });
    expect(afterDelete.json().questions.map((q: Question) => q.wordId)).not.toContain(oldest);

    await call(user, 'DELETE', `/packs/${packId}`);
    expect(await summary(user)).toMatchObject({ dueCount: 0 });
  });
});
