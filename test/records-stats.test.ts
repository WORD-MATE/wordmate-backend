import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
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
import { datesBetween, periodStart } from '../src/modules/records/stats.js';
import { createTestApp, inject } from './support/create-test-app.js';

type Question = { index: number; wordId: string; answerIndex: number | null };

describe('학습 기록·통계', () => {
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
      .values({ id: userId, name: '기록유저', role: 'STUDENT', grade: 1, classNo: 4 });
    return { userId, role: 'STUDENT', isAdmin: false, deviceId: newId() };
  };

  const call = async (
    user: AuthUser,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const createPack = async (user: AuthUser, count = 4) => {
    const packId = (
      await call(user, 'POST', '/packs', { name: `기록 ${newId().slice(-8)}` })
    ).json().packId as string;
    await call(user, 'POST', `/packs/${packId}/words`, {
      words: Array.from({ length: count }, (_, i) => ({
        english: `word${i}`,
        meanings: [`뜻${i}`],
      })),
    });
    return packId;
  };

  /** wrong에 든 index는 틀리게(플래시카드는 몰라요) 답하고 끝낸다 */
  const play = async (user: AuthUser, body: object, wrong: number[] = []) => {
    const started = await call(user, 'POST', '/study/sessions', {
      mode: 'CHOICE',
      direction: 'EN_TO_KO',
      shuffle: false,
      force: true,
      ...body,
    });
    expect(started.statusCode).toBe(201);
    const { sessionId, questions, mode } = started.json() as {
      sessionId: string;
      questions: Question[];
      mode: string;
    };
    for (const q of questions) {
      const miss = wrong.includes(q.index);
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
    return { recordId: done.json().recordId as string, questions };
  };

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

  it('기록 목록·상세: 최신순, 날짜 필터, 권한, 삭제된 팩은 null', async () => {
    const user = await makeUser();
    const other = await makeUser();
    const packId = await createPack(user);
    const choice = await play(user, { source: 'PACK', packId }, [1]);
    const flash = await play(user, { source: 'PACK', packId, mode: 'FLASHCARD' }, [0, 2]);

    const list = (await call(user, 'GET', '/records')).json();
    expect(list.items.map((r: { recordId: string }) => r.recordId)).toEqual([
      flash.recordId,
      choice.recordId,
    ]);
    expect(list.items[1]).toMatchObject({
      pack: { packId, name: expect.any(String) },
      source: 'PACK',
      mode: 'CHOICE',
      direction: 'EN_TO_KO',
      correctCount: 3,
      wrongCount: 1,
      accuracy: 75,
    });
    const page1 = (await call(user, 'GET', '/records?size=1')).json();
    const page2 = (await call(user, 'GET', `/records?size=1&cursor=${page1.nextCursor}`)).json();
    expect(page2.items[0].recordId).toBe(choice.recordId);
    expect(page2.nextCursor).toBeNull();
    expect((await call(user, 'GET', `/records?date=${today}`)).json().items).toHaveLength(2);
    expect((await call(user, 'GET', `/records?date=${shift(-1)}`)).json().items).toEqual([]);
    expect((await call(other, 'GET', '/records')).json().items).toEqual([]);

    const detail = (await call(user, 'GET', `/records/${choice.recordId}`)).json();
    expect(detail).toMatchObject({
      recordId: choice.recordId,
      knownCount: null,
      unknownCount: null,
    });
    expect(
      detail.items.map((i: { english: string; correct: boolean }) => [i.english, i.correct]),
    ).toEqual([
      ['word0', true],
      ['word1', false],
      ['word2', true],
      ['word3', true],
    ]);
    const flashDetail = (await call(user, 'GET', `/records/${flash.recordId}`)).json();
    expect(flashDetail).toMatchObject({ accuracy: null, knownCount: 2, unknownCount: 2 });
    expect(flashDetail.items[0]).toMatchObject({ correct: null, known: false });

    expect((await call(other, 'GET', `/records/${choice.recordId}`)).statusCode).toBe(403);
    expect((await call(user, 'GET', `/records/${newId()}`)).json().code).toBe('RECORD_NOT_FOUND');

    await call(user, 'DELETE', `/packs/${packId}`);
    const afterDelete = (await call(user, 'GET', `/records/${choice.recordId}`)).json();
    expect(afterDelete.pack).toEqual({ packId: null, name: null });
    expect(afterDelete.items).toHaveLength(4);
  });

  it('틀린 단어만 다시 풀기 (source=RECORD_WRONG)', async () => {
    const user = await makeUser();
    const other = await makeUser();
    const packId = await createPack(user);
    const choice = await play(user, { source: 'PACK', packId }, [1, 3]);
    const flash = await play(user, { source: 'PACK', packId, mode: 'FLASHCARD' }, [2]);

    const retry = (
      await call(user, 'POST', '/study/sessions', {
        source: 'RECORD_WRONG',
        recordId: choice.recordId,
        mode: 'FLASHCARD',
        direction: 'EN_TO_KO',
        shuffle: false,
      })
    ).json();
    expect(retry.pack).toBeNull();
    expect(retry.questions.map((q: Question) => q.wordId)).toEqual([
      choice.questions[1]?.wordId,
      choice.questions[3]?.wordId,
    ]);

    const fromFlash = await call(user, 'POST', '/study/sessions', {
      source: 'RECORD_WRONG',
      recordId: flash.recordId,
      mode: 'TYPING',
      direction: 'EN_TO_KO',
      shuffle: false,
      force: true,
    });
    expect(fromFlash.json().questions.map((q: Question) => q.wordId)).toEqual([
      flash.questions[2]?.wordId,
    ]);

    const body = { source: 'RECORD_WRONG', mode: 'CHOICE', direction: 'EN_TO_KO', shuffle: false };
    expect(
      (await call(other, 'POST', '/study/sessions', { ...body, recordId: choice.recordId }))
        .statusCode,
    ).toBe(403);
    expect(
      (await call(user, 'POST', '/study/sessions', { ...body, recordId: newId() })).json().code,
    ).toBe('RECORD_NOT_FOUND');
    expect((await call(user, 'POST', '/study/sessions', body)).statusCode).toBe(400);

    // 다 맞힌 기록은 다시 풀 단어가 없다
    const perfect = await play(user, { source: 'PACK', packId });
    expect(
      (
        await call(user, 'POST', '/study/sessions', {
          ...body,
          recordId: perfect.recordId,
          force: true,
        })
      ).json().code,
    ).toBe('STUDY_EMPTY');
  });

  it('스트릭: 처음 0, 학습하면 1, 이틀 이상 비면 0 (최고 기록 유지)', async () => {
    const user = await makeUser();
    expect((await call(user, 'GET', '/stats/streak')).json()).toEqual({
      current: 0,
      best: 0,
      todayDone: false,
    });
    await play(user, { source: 'PACK', packId: await createPack(user) });
    expect((await call(user, 'GET', '/stats/streak')).json()).toEqual({
      current: 1,
      best: 1,
      todayDone: true,
    });
    await db
      .update(userStreaks)
      .set({ current: 6, best: 8, lastDate: shift(-1) })
      .where(eq(userStreaks.userId, user.userId));
    expect((await call(user, 'GET', '/stats/streak')).json()).toEqual({
      current: 6,
      best: 8,
      todayDone: false,
    });
    await db
      .update(userStreaks)
      .set({ lastDate: shift(-2) })
      .where(eq(userStreaks.userId, user.userId));
    expect((await call(user, 'GET', '/stats/streak')).json()).toMatchObject({
      current: 0,
      best: 8,
    });
  });

  it('달력은 학습한 날만, 미래의 달은 400', async () => {
    const user = await makeUser();
    const lastMonthDay = Temporal.PlainDate.from(today)
      .with({ day: 1 })
      .subtract({ days: 1 })
      .toString();
    await db.insert(dailyStudyStats).values([
      {
        userId: user.userId,
        date: today,
        solvedCount: 12,
        gradedCount: 10,
        correctCount: 8,
        sessionsCompleted: 2,
      },
      {
        userId: user.userId,
        date: lastMonthDay,
        solvedCount: 5,
        gradedCount: 5,
        correctCount: 5,
        sessionsCompleted: 1,
      },
    ]);
    const month = today.slice(0, 7);
    expect((await call(user, 'GET', `/stats/calendar?month=${month}`)).json()).toEqual({
      month,
      days: [{ date: today, solvedCount: 12 }],
    });
    expect(
      (await call(user, 'GET', `/stats/calendar?month=${lastMonthDay.slice(0, 7)}`)).json().days,
    ).toEqual([{ date: lastMonthDay, solvedCount: 5 }]);
    const nextMonth = Temporal.PlainDate.from(today)
      .with({ day: 1 })
      .add({ months: 1 })
      .toString()
      .slice(0, 7);
    expect((await call(user, 'GET', `/stats/calendar?month=${nextMonth}`)).statusCode).toBe(400);
    expect((await call(user, 'GET', '/stats/calendar?month=2026-13')).statusCode).toBe(400);
  });

  it('통계: 기간 합계·정답률·서로 다른 단어 수, 그래프는 첫날부터 오늘까지', async () => {
    const user = await makeUser();
    // 이번 주가 지난달에 걸쳐 시작할 수 있어 두 기간보다 모두 앞선 날을 기간 밖 데이터로 쓴다
    const earliest = [periodStart('WEEK', today), periodStart('MONTH', today)].sort()[0] as string;
    const before = Temporal.PlainDate.from(earliest).subtract({ days: 1 }).toString();
    await db.insert(dailyStudyStats).values([
      {
        userId: user.userId,
        date: today,
        solvedCount: 10,
        gradedCount: 8,
        correctCount: 6,
        sessionsCompleted: 1,
      },
      {
        userId: user.userId,
        date: before,
        solvedCount: 99,
        gradedCount: 99,
        correctCount: 99,
        sessionsCompleted: 9,
      },
    ]);
    const w1 = newId();
    const w2 = newId();
    await db.insert(dailyStudiedWords).values([
      { userId: user.userId, date: today, wordId: w1 },
      { userId: user.userId, date: today, wordId: w2 },
      { userId: user.userId, date: before, wordId: newId() },
    ]);

    const todayStats = (await call(user, 'GET', '/stats/summary?period=TODAY')).json();
    expect(todayStats).toEqual({
      period: 'TODAY',
      studiedWordCount: 2,
      solvedCount: 10,
      correctCount: 6,
      accuracy: 75,
      series: [],
    });

    for (const period of ['WEEK', 'MONTH'] as const) {
      const stats = (await call(user, 'GET', `/stats/summary?period=${period}`)).json();
      expect(stats).toMatchObject({ period, studiedWordCount: 2, solvedCount: 10, accuracy: 75 });
      const dates = datesBetween(periodStart(period, today), today);
      expect(stats.series.map((d: { date: string }) => d.date)).toEqual(dates);
      expect(stats.series.at(-1)).toEqual({ date: today, solvedCount: 10, accuracy: 75 });
      if (dates.length > 1)
        expect(stats.series[0]).toMatchObject({ solvedCount: 0, accuracy: null });
    }

    const empty = await makeUser();
    expect((await call(empty, 'GET', '/stats/summary?period=WEEK')).json()).toMatchObject({
      studiedWordCount: 0,
      solvedCount: 0,
      accuracy: null,
    });
  });
});
