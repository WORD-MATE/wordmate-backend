import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  morningSentences,
  type NewUser,
  packs,
  users,
  words,
  xpLedger,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { MORNING_XP, morningDate } from '../src/modules/morning/morning-rules.js';
import { applyMorningSeed, type MorningSeed } from '../src/modules/morning/seed/morning-seed.js';
import { createTestApp, inject } from './support/create-test-app.js';

type SeedSentence = MorningSeed['sentences'][number];

describe('오늘의 문장', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];
  const today = morningDate();
  const shift = (days: number) => Temporal.PlainDate.from(today).add({ days }).toString();
  const yesterday = shift(-1);
  const tomorrow = shift(1);
  const dates = [shift(-3), shift(-2), yesterday, today, tomorrow];

  const sentenceFor = (date: string): SeedSentence => ({
    date,
    sentence: `Persistence is the key ${date}.`,
    translation: '꾸준함이 열쇠다.',
    keywords: [
      { english: 'persistence', meanings: ['끈기'], highlight: { start: 0, end: 11 } },
      { english: 'key', meanings: ['열쇠'], highlight: { start: 19, end: 22 } },
    ],
    quizzes: [
      { type: 'FILL_BLANK', question: '_____ is the key.', answers: ['Persistence'] },
      {
        type: 'MEANING',
        question: 'key의 뜻은?',
        choices: ['열쇠', '문'],
        answers: ['열쇠'],
      },
    ],
  });

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `아침${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 2 : null,
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

  const allCorrect = {
    answers: [
      { index: 0, answer: ' persistence ' },
      { index: 1, answer: '열쇠' },
    ],
  };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
  });

  afterAll(async () => {
    await db.delete(morningSentences).where(inArray(morningSentences.publishDate, dates));
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

  it('게시된 문장이 없으면 404, 오늘 문장이 없으면 가장 최근 문장(isFallback)', async () => {
    const user = await makeUser();
    expect((await call(user, 'GET', '/morning/today')).json().code).toBe('MORNING_NOT_FOUND');
    expect((await call(user, 'GET', '/home')).json().morning).toBeNull();

    await applyMorningSeed(db, { sentences: [sentenceFor(shift(-2)), sentenceFor(yesterday)] });
    const res = await call(user, 'GET', '/morning/today');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      date: yesterday,
      isFallback: true,
      completed: false,
      streak: { current: 0 },
      keywords: [
        { index: 0, english: 'persistence', highlight: { start: 0, end: 11 }, example: null },
        { index: 1, english: 'key' },
      ],
      quizzes: [
        { index: 0, type: 'FILL_BLANK', choices: null, answers: ['Persistence'] },
        { index: 1, type: 'MEANING', choices: ['열쇠', '문'] },
      ],
    });
  });

  it('미래·게시 전 날짜는 404, 목록은 게시된 문장만 최신순', async () => {
    const user = await makeUser();
    await applyMorningSeed(db, { sentences: [sentenceFor(today), sentenceFor(tomorrow)] });
    await applyMorningSeed(db, { sentences: [sentenceFor(shift(-3))] });
    await db
      .update(morningSentences)
      .set({ status: 'SCHEDULED' })
      .where(eq(morningSentences.publishDate, shift(-3)));

    expect((await call(user, 'GET', '/morning/today')).json()).toMatchObject({
      date: today,
      isFallback: false,
    });
    for (const date of [tomorrow, shift(-3)]) {
      expect((await call(user, 'GET', `/morning/${date}`)).json().code).toBe('MORNING_NOT_FOUND');
    }
    expect((await call(user, 'GET', `/morning/${yesterday}`)).json()).toMatchObject({
      date: yesterday,
      isFallback: false,
    });

    const first = (await call(user, 'GET', '/morning?size=2')).json();
    expect(first.items.map((i: { date: string }) => i.date)).toEqual([today, yesterday]);
    const second = (await call(user, 'GET', `/morning?size=2&cursor=${first.nextCursor}`)).json();
    expect(second.items.map((i: { date: string }) => i.date)).toEqual([shift(-2)]);
    expect(second.nextCursor).toBeNull();
  });

  it('오늘 문장을 처음 끝내면 XP·연속 기록, 다시 끝내면 추가 지급 없음', async () => {
    const user = await makeUser();
    const res = await call(user, 'POST', `/morning/${today}/quiz/complete`, {
      answers: [
        { index: 0, answer: ' PERSISTENCE ' },
        { index: 1, answer: '문' },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      correctCount: 1,
      total: 2,
      results: [
        { index: 0, correct: true },
        { index: 1, correct: false },
      ],
      xp: { earned: MORNING_XP, blockedReason: null, todayTotal: MORNING_XP },
      alreadyCompletedToday: false,
      streak: { current: 1, increased: true },
    });

    const again = (await call(user, 'POST', `/morning/${today}/quiz/complete`, allCorrect)).json();
    expect(again).toMatchObject({
      correctCount: 2,
      xp: { earned: 0 },
      alreadyCompletedToday: true,
      streak: { current: 1, increased: false },
    });
    const [row] = await db
      .select({ totalXp: users.totalXp })
      .from(users)
      .where(eq(users.id, user.userId));
    expect(row?.totalXp).toBe(MORNING_XP);

    const view = (await call(user, 'GET', '/morning/today')).json();
    expect(view).toMatchObject({ completed: true, streak: { current: 1 } });
    expect((await call(user, 'GET', '/home')).json().morning).toEqual({
      date: today,
      sentence: view.sentence,
      translation: view.translation,
      keywords: ['persistence', 'key'],
      completed: true,
      isFallback: false,
    });
  });

  it('지난 문장은 기록만 남고 XP·연속 기록은 없다', async () => {
    const user = await makeUser();
    const res = (
      await call(user, 'POST', `/morning/${yesterday}/quiz/complete`, allCorrect)
    ).json();
    expect(res).toMatchObject({
      correctCount: 2,
      xp: { earned: 0, todayTotal: 0 },
      alreadyCompletedToday: false,
      streak: { current: 0, increased: false },
    });
    const list = (await call(user, 'GET', '/morning')).json();
    expect(
      list.items.map((i: { date: string; completed: boolean }) => [i.date, i.completed]),
    ).toEqual([
      [today, false],
      [yesterday, true],
      [shift(-2), false],
    ]);
  });

  it('모든 문항에 한 번씩 답해야 하고, 교사는 풀 수 없다', async () => {
    const user = await makeUser();
    const teacher = await makeUser({ role: 'TEACHER', isAdmin: true });
    const url = `/morning/${today}/quiz/complete`;
    for (const answers of [
      [{ index: 0, answer: 'persistence' }],
      [
        { index: 0, answer: 'persistence' },
        { index: 0, answer: 'persistence' },
      ],
      [
        { index: 0, answer: 'persistence' },
        { index: 5, answer: '열쇠' },
      ],
    ]) {
      expect((await call(user, 'POST', url, { answers })).statusCode).toBe(400);
    }
    expect((await call(teacher, 'POST', url, allCorrect)).statusCode).toBe(403);
    expect(
      (await call(user, 'POST', `/morning/${tomorrow}/quiz/complete`, allCorrect)).statusCode,
    ).toBe(404);
  });

  it('핵심 어휘를 새 팩이나 내 팩에 저장하고, 중복은 건너뛰며 한도를 넘으면 409', async () => {
    const user = await makeUser();
    const url = `/morning/${today}/save-words`;
    const created = await call(user, 'POST', url, { newPackName: '아침 단어' });
    expect(created.statusCode).toBe(200);
    const { packId } = created.json();
    expect(created.json()).toEqual({ packId, saved: 2, skipped: 0 });
    expect((await call(user, 'POST', url, { packId })).json()).toEqual({
      packId,
      saved: 0,
      skipped: 2,
    });
    expect(
      (
        await call(user, 'POST', `/morning/${yesterday}/save-words`, {
          packId,
          keywordIndexes: [1],
        })
      ).json(),
    ).toEqual({ packId, saved: 0, skipped: 1 });

    expect((await call(user, 'POST', url, {})).statusCode).toBe(400);
    expect((await call(user, 'POST', url, { packId, newPackName: '둘 다' })).statusCode).toBe(400);
    expect((await call(user, 'POST', url, { packId, keywordIndexes: [5] })).statusCode).toBe(400);
    expect((await call(user, 'POST', url, { packId: newId() })).json().code).toBe('PACK_NOT_FOUND');

    const full = (await call(user, 'POST', '/packs', { name: '가득 찬 팩' })).json().packId;
    await db.update(packs).set({ wordCount: 999 }).where(eq(packs.id, full));
    const over = await call(user, 'POST', url, { packId: full });
    expect(over.statusCode).toBe(409);
    expect(over.json().code).toBe('PACK_WORD_LIMIT_EXCEEDED');
    expect(await db.select().from(words).where(eq(words.packId, full))).toEqual([]);
  });
});
