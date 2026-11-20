import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  packs,
  studySessions,
  users,
  userWordProgress,
  words,
  wrongNotes,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { createTestApp, inject } from './support/create-test-app.js';

type Question = { index: number; wordId: string; prompt: string; answerIndex: number | null };

describe('학습 답안 제출', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];

  const makeUser = async (): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    await db
      .insert(users)
      .values({ id: userId, name: '답안유저', role: 'STUDENT', grade: 1, classNo: 2 });
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

  /** word0 / 뜻0·풀이0 … */
  const createPack = async (user: AuthUser, count = 4) => {
    const packId = (
      await call(user, 'POST', '/packs', { name: `답안 ${newId().slice(-8)}` })
    ).json().packId as string;
    await call(user, 'POST', `/packs/${packId}/words`, {
      words: Array.from({ length: count }, (_, i) => ({
        english: `word${i}`,
        meanings: [`뜻${i}`, `풀이 ${i}`],
      })),
    });
    return packId;
  };

  const start = async (user: AuthUser, packId: string, mode: string, direction = 'EN_TO_KO') => {
    const res = await call(user, 'POST', '/study/sessions', {
      source: 'PACK',
      packId,
      mode,
      direction,
      shuffle: false,
      force: true,
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { sessionId: string; questions: Question[] };
  };

  const answer = (user: AuthUser, sessionId: string, body: object, key?: string) =>
    call(
      user,
      'POST',
      `/study/sessions/${sessionId}/answers`,
      { elapsedMs: 2000, ...body },
      key ? { 'idempotency-key': key } : {},
    );

  const wrongChoice = (q: Question) => ((q.answerIndex as number) + 1) % 4;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
  });

  afterAll(async () => {
    await db.delete(studySessions).where(inArray(studySessions.userId, userIds));
    await db.delete(wrongNotes).where(inArray(wrongNotes.userId, userIds));
    await db.delete(userWordProgress).where(inArray(userWordProgress.userId, userIds));
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

  it('4지선다 채점, 다시 내면 409, 복원 응답과 이어할 학습에 반영', async () => {
    const user = await makeUser();
    const packId = await createPack(user);
    const { sessionId, questions } = await start(user, packId, 'CHOICE');
    const [q0, q1] = questions as [Question, Question];

    const right = await answer(user, sessionId, { index: 0, choiceIndex: q0.answerIndex });
    expect(right.statusCode).toBe(200);
    expect(right.json()).toEqual({ index: 0, correct: true, correctAnswer: null, counted: true });
    const wrong = await answer(user, sessionId, { index: 1, choiceIndex: wrongChoice(q1) });
    expect(wrong.json()).toMatchObject({ correct: false, correctAnswer: null });

    const again = await answer(user, sessionId, { index: 0, choiceIndex: q0.answerIndex });
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('STUDY_ANSWER_ALREADY_SUBMITTED');

    const restored = (await call(user, 'GET', `/study/sessions/${sessionId}`)).json();
    expect(restored.answers).toEqual([
      { index: 0, correct: true, known: null, userAnswer: null },
      { index: 1, correct: false, known: null, userAnswer: null },
    ]);
    const current = (await call(user, 'GET', '/study/sessions/current')).json();
    expect(current).toMatchObject({ sessionId, answered: 2, total: 4 });

    const [note] = await db
      .select()
      .from(wrongNotes)
      .where(and(eq(wrongNotes.userId, user.userId), eq(wrongNotes.wordId, q1.wordId)));
    expect(note).toMatchObject({
      questionType: 'EN_TO_KO_CHOICE',
      source: 'STUDY',
      status: 'ACTIVE',
      wrongCount: 1,
      packId,
    });
  });

  it('직접 입력: 띄어쓰기·대소문자 무시, 틀리면 정답을 알려준다', async () => {
    const user = await makeUser();
    const packId = await createPack(user);
    const enToKo = await start(user, packId, 'TYPING');
    expect(
      (await answer(user, enToKo.sessionId, { index: 2, typedAnswer: ' 풀이2 ' })).json().correct,
    ).toBe(true);
    const miss = await answer(user, enToKo.sessionId, { index: 3, typedAnswer: '모름' });
    expect(miss.json()).toMatchObject({
      correct: false,
      correctAnswer: { english: 'word3', meanings: ['뜻3', '풀이 3'] },
    });
    const restored = (await call(user, 'GET', `/study/sessions/${enToKo.sessionId}`)).json();
    expect(restored.answers[1]).toMatchObject({ index: 3, userAnswer: '모름' });

    const koToEn = await start(user, packId, 'TYPING', 'KO_TO_EN');
    expect(
      (await answer(user, koToEn.sessionId, { index: 1, typedAnswer: 'WORD1' })).json().correct,
    ).toBe(true);
    expect((await answer(user, koToEn.sessionId, { index: 0 })).statusCode).toBe(400);
  });

  it('플래시카드는 덮어쓰고, 0.5초 미만은 counted=false, 잘못된 요청은 400·403·404', async () => {
    const user = await makeUser();
    const other = await makeUser();
    const packId = await createPack(user);
    const { sessionId } = await start(user, packId, 'FLASHCARD');

    const first = await answer(user, sessionId, { index: 0, known: false, elapsedMs: 100 });
    expect(first.json()).toEqual({ index: 0, correct: null, correctAnswer: null, counted: false });
    expect((await answer(user, sessionId, { index: 0, known: true })).json().counted).toBe(true);
    const restored = (await call(user, 'GET', `/study/sessions/${sessionId}`)).json();
    expect(restored.answers).toEqual([{ index: 0, correct: null, known: true, userAnswer: null }]);
    expect((await call(user, 'GET', '/study/sessions/current')).json().answered).toBe(1);

    expect((await answer(user, sessionId, { index: 4, known: true })).statusCode).toBe(400);
    expect((await answer(user, sessionId, { index: 1, choiceIndex: 0 })).statusCode).toBe(400);
    expect((await answer(other, sessionId, { index: 1, known: true })).statusCode).toBe(403);

    await call(user, 'DELETE', `/study/sessions/${sessionId}`);
    expect((await answer(user, sessionId, { index: 1, known: true })).statusCode).toBe(404);
  });

  it('같은 Idempotency-Key로 다시 보내면 저장한 응답을 그대로 돌려준다', async () => {
    const user = await makeUser();
    const packId = await createPack(user);
    const { sessionId, questions } = await start(user, packId, 'CHOICE');
    const key = randomUUID();
    const body = { index: 0, choiceIndex: questions[0]?.answerIndex };
    const first = await answer(user, sessionId, body, key);
    const retry = await answer(user, sessionId, body, key);
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json()).toEqual(first.json());
    expect((await answer(user, sessionId, body, randomUUID())).statusCode).toBe(409);
  });

  it('서로 다른 학습에서 3번 맞히면 MEMORIZED, 틀리면 LEARNING. 단어팩 집계·필터에 반영', async () => {
    const user = await makeUser();
    const packId = await createPack(user);
    for (let round = 0; round < 3; round++) {
      const { sessionId, questions } = await start(user, packId, 'CHOICE');
      const q0 = questions[0] as Question;
      await answer(user, sessionId, { index: 0, choiceIndex: q0.answerIndex });
      if (round === 0) {
        await answer(user, sessionId, {
          index: 1,
          choiceIndex: wrongChoice(questions[1] as Question),
        });
      }
    }

    const detail = (await call(user, 'GET', `/packs/${packId}`)).json();
    expect(detail.memoryStatusCount).toEqual({ NEW: 2, LEARNING: 1, MEMORIZED: 1 });
    expect(detail.progress).toEqual({ studied: 2, total: 4 });
    expect(detail.lastStudiedAt).not.toBeNull();
    const listed = (await call(user, 'GET', '/packs?type=MINE')).json().items;
    expect(listed.find((p: { packId: string }) => p.packId === packId).progress.studied).toBe(2);

    const byStatus = async (status: string) =>
      (await call(user, 'GET', `/packs/${packId}/words?memoryStatus=${status}`))
        .json()
        .items.map((w: { english: string; memoryStatus: string }) => [w.english, w.memoryStatus]);
    expect(await byStatus('MEMORIZED')).toEqual([['word0', 'MEMORIZED']]);
    expect(await byStatus('LEARNING')).toEqual([['word1', 'LEARNING']]);
    expect(await byStatus('NEW')).toEqual([
      ['word2', 'NEW'],
      ['word3', 'NEW'],
    ]);

    const { sessionId, questions } = await start(user, packId, 'CHOICE');
    await answer(user, sessionId, { index: 0, choiceIndex: wrongChoice(questions[0] as Question) });
    expect(await byStatus('MEMORIZED')).toEqual([]);
    expect((await call(user, 'GET', `/packs/${packId}`)).json().memoryStatusCount).toEqual({
      NEW: 2,
      LEARNING: 2,
      MEMORIZED: 0,
    });
  });

  it('오답은 같은 방식으로 2번 연속 맞히면 졸업, 다시 틀리면 ACTIVE', async () => {
    const user = await makeUser();
    const packId = await createPack(user);
    const note = async () =>
      (await db.select().from(wrongNotes).where(eq(wrongNotes.userId, user.userId)))[0];

    const s1 = await start(user, packId, 'CHOICE');
    await answer(user, s1.sessionId, {
      index: 0,
      choiceIndex: wrongChoice(s1.questions[0] as Question),
    });

    // 다른 방식(직접 입력)으로 맞힌 것은 세지 않는다
    const typing = await start(user, packId, 'TYPING');
    await answer(user, typing.sessionId, { index: 0, typedAnswer: '뜻0' });
    expect(await note()).toMatchObject({ consecutiveCorrect: 0, status: 'ACTIVE' });

    for (let i = 0; i < 2; i++) {
      const s = await start(user, packId, 'CHOICE');
      await answer(user, s.sessionId, { index: 0, choiceIndex: s.questions[0]?.answerIndex });
    }
    expect(await note()).toMatchObject({ consecutiveCorrect: 2, status: 'GRADUATED' });

    const s4 = await start(user, packId, 'CHOICE');
    await answer(user, s4.sessionId, {
      index: 0,
      choiceIndex: wrongChoice(s4.questions[0] as Question),
    });
    expect(await note()).toMatchObject({
      status: 'ACTIVE',
      wrongCount: 2,
      consecutiveCorrect: 0,
      graduatedAt: null,
    });
  });
});
