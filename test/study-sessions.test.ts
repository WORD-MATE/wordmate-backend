import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  packCopies,
  packs,
  studySessions,
  users,
  wordFavorites,
  words,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { createTestApp, inject } from './support/create-test-app.js';

type Question = {
  index: number;
  wordId: string;
  prompt: string;
  choices: string[] | null;
  answerIndex: number | null;
  card: { english: string; meanings: string[] } | null;
};

describe('학습 세션', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];

  const makeUser = async (): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    await db
      .insert(users)
      .values({ id: userId, name: '학습유저', role: 'STUDENT', grade: 1, classNo: 1 });
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

  /** word0 / 뜻0, word1 / 뜻1 … */
  const createPack = async (user: AuthUser, count: number) => {
    const created = await call(user, 'POST', '/packs', { name: `학습 ${newId().slice(-8)}` });
    const packId = created.json().packId as string;
    if (count > 0) {
      await call(user, 'POST', `/packs/${packId}/words`, {
        words: Array.from({ length: count }, (_, i) => ({
          english: `word${i}`,
          meanings: [`뜻${i}`, `풀이${i}`],
        })),
      });
    }
    const items = (await call(user, 'GET', `/packs/${packId}/words?size=50`)).json().items;
    return { packId, wordIds: items.map((w: { wordId: string }) => w.wordId) as string[] };
  };

  const start = (user: AuthUser, body: object) =>
    call(user, 'POST', '/study/sessions', {
      mode: 'CHOICE',
      direction: 'EN_TO_KO',
      shuffle: false,
      ...body,
    });

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
  });

  afterAll(async () => {
    await db.delete(studySessions).where(inArray(studySessions.userId, userIds));
    await db.delete(wordFavorites).where(inArray(wordFavorites.userId, userIds));
    const owned = await db
      .select({ id: packs.id })
      .from(packs)
      .where(inArray(packs.ownerUserId, userIds));
    const ids = owned.map((row) => row.id);
    if (ids.length > 0) {
      await db.delete(packCopies).where(inArray(packCopies.sourcePackId, ids));
      await db.delete(words).where(inArray(words.packId, ids));
      await db.delete(packs).where(inArray(packs.id, ids));
    }
    await app.close();
  });

  it('4지선다: 보기 4개·정답 위치, 문제 수가 단어보다 많으면 전체, 순서 고정', async () => {
    const user = await makeUser();
    const { packId, wordIds } = await createPack(user, 5);
    const res = await start(user, { source: 'PACK', packId, questionCount: 10 });
    expect(res.statusCode).toBe(201);
    const session = res.json();
    expect(session).toMatchObject({
      source: 'PACK',
      pack: { packId },
      mode: 'CHOICE',
      direction: 'EN_TO_KO',
      status: 'IN_PROGRESS',
      answers: [],
    });
    const questions = session.questions as Question[];
    expect(questions.map((q) => q.wordId)).toEqual(wordIds);
    for (const [i, q] of questions.entries()) {
      expect(q.index).toBe(i);
      expect(q.prompt).toBe(`word${i}`);
      expect(q.choices).toHaveLength(4);
      expect(new Set(q.choices).size).toBe(4);
      expect(q.choices?.[q.answerIndex as number]).toBe(`뜻${i}`);
      expect(q.card).toBeNull();
    }

    // 다시 조회해도 문항·보기가 그대로
    const restored = (await call(user, 'GET', `/study/sessions/${session.sessionId}`)).json();
    expect(restored.questions).toEqual(questions);
  });

  it('문제 수·섞기, TYPING은 정답을 내려주지 않는다', async () => {
    const user = await makeUser();
    const { packId, wordIds } = await createPack(user, 25);
    const ten = (await start(user, { source: 'PACK', packId, questionCount: 10 })).json();
    expect(ten.questions.map((q: Question) => q.wordId)).toEqual(wordIds.slice(0, 10));

    const typing = await start(user, {
      source: 'PACK',
      packId,
      mode: 'TYPING',
      direction: 'KO_TO_EN',
      shuffle: true,
      force: true,
    });
    expect(typing.statusCode).toBe(201);
    const questions = typing.json().questions as Question[];
    expect(questions).toHaveLength(25);
    expect(new Set(questions.map((q) => q.wordId))).toEqual(new Set(wordIds));
    const byWord = questions.find((q) => q.wordId === wordIds[3]);
    expect(byWord).toMatchObject({ prompt: '뜻3, 풀이3', choices: null, answerIndex: null });
    expect(typing.body).not.toContain('acceptedAnswers');
    expect(typing.body).not.toContain('"word3"');
  });

  it('단어가 없거나 4지선다 보기가 모자라면 400, 남의 팩은 403', async () => {
    const user = await makeUser();
    const other = await makeUser();
    const empty = await createPack(user, 0);
    expect((await start(user, { source: 'PACK', packId: empty.packId })).json().code).toBe(
      'STUDY_EMPTY',
    );
    const three = await createPack(user, 3);
    expect((await start(user, { source: 'PACK', packId: three.packId })).json().code).toBe(
      'STUDY_TOO_FEW_WORDS',
    );
    const flashcard = await start(user, {
      source: 'PACK',
      packId: three.packId,
      mode: 'FLASHCARD',
    });
    expect(flashcard.statusCode).toBe(201);
    expect(flashcard.json().questions[0].card).toEqual({
      english: 'word0',
      meanings: ['뜻0', '풀이0'],
    });

    expect((await start(other, { source: 'PACK', packId: three.packId })).statusCode).toBe(403);
    expect((await start(user, { source: 'PACK' })).statusCode).toBe(400);
    expect((await start(user, { source: 'WRONG_NOTE' })).statusCode).toBe(400);
  });

  it('같은 팩에 이어할 학습이 있으면 409, force면 새로 시작하고 예전 것은 버린다', async () => {
    const user = await makeUser();
    const other = await makeUser();
    const { packId } = await createPack(user, 4);
    const first = (await start(user, { source: 'PACK', packId })).json();

    const conflict = await start(user, { source: 'PACK', packId, mode: 'FLASHCARD' });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({
      code: 'STUDY_SESSION_EXISTS',
      detail: { sessionId: first.sessionId },
    });

    const current = (await call(user, 'GET', '/study/sessions/current')).json();
    expect(current).toMatchObject({
      sessionId: first.sessionId,
      source: 'PACK',
      pack: { packId },
      mode: 'CHOICE',
      answered: 0,
      total: 4,
    });
    expect((await call(other, 'GET', `/study/sessions/${first.sessionId}`)).statusCode).toBe(403);

    const forced = await start(user, { source: 'PACK', packId, force: true });
    expect(forced.statusCode).toBe(201);
    expect((await call(user, 'GET', `/study/sessions/${first.sessionId}`)).json().code).toBe(
      'STUDY_SESSION_NOT_FOUND',
    );

    const sessionId = forced.json().sessionId;
    expect((await call(other, 'DELETE', `/study/sessions/${sessionId}`)).statusCode).toBe(403);
    expect((await call(user, 'DELETE', `/study/sessions/${sessionId}`)).statusCode).toBe(204);
    expect((await call(user, 'DELETE', `/study/sessions/${sessionId}`)).statusCode).toBe(404);
    const none = await call(user, 'GET', '/study/sessions/current');
    expect(none.statusCode).toBe(200);
    expect(none.json()).toBeNull();
  });

  it('7일이 지난 학습은 만료로 보고, 같은 팩을 새로 시작할 수 있다', async () => {
    const user = await makeUser();
    const { packId } = await createPack(user, 4);
    const old = (await start(user, { source: 'PACK', packId })).json();
    await db
      .update(studySessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(studySessions.id, old.sessionId));

    expect((await call(user, 'GET', '/study/sessions/current')).json()).toBeNull();
    expect((await call(user, 'GET', `/study/sessions/${old.sessionId}`)).statusCode).toBe(404);
    expect((await start(user, { source: 'PACK', packId })).statusCode).toBe(201);
  });

  it('즐겨찾기 학습: 고른 단어만, 보기는 그 단어의 팩에서', async () => {
    const user = await makeUser();
    const a = await createPack(user, 4);
    const b = await createPack(user, 4);
    const picked = [a.wordIds[0], a.wordIds[1], b.wordIds[2]] as string[];
    for (const wordId of [...picked, b.wordIds[3]]) {
      expect((await call(user, 'PUT', `/words/${wordId}/favorite`)).statusCode).toBe(204);
    }

    const res = await start(user, { source: 'FAVORITE', wordIds: picked });
    expect(res.statusCode).toBe(201);
    expect(res.json().pack).toBeNull();
    const questions = res.json().questions as Question[];
    expect(new Set(questions.map((q) => q.wordId))).toEqual(new Set(picked));
    for (const q of questions) {
      expect(q.choices).toHaveLength(4);
      // 두 팩 모두 word0~word3이라 보기는 항상 뜻0~뜻3
      expect([...(q.choices ?? [])].sort()).toEqual(['뜻0', '뜻1', '뜻2', '뜻3']);
    }

    // 즐겨찾기 학습도 하나만 이어할 수 있다
    expect((await start(user, { source: 'FAVORITE' })).statusCode).toBe(409);
    const all = await start(user, { source: 'FAVORITE', mode: 'FLASHCARD', force: true });
    expect(all.json().questions).toHaveLength(4);
    // 팩 학습과는 따로
    expect((await start(user, { source: 'PACK', packId: a.packId })).statusCode).toBe(201);
  });
});
