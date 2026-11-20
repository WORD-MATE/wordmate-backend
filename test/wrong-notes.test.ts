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
type Note = {
  wrongNoteId: string;
  word: { wordId: string; english: string; memoryStatus: string };
  pack: { packId: string; name: string } | null;
  questionType: string;
  wrongCount: number;
};

describe('오답노트', () => {
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
      .values({ id: userId, name: '오답유저', role: 'STUDENT', grade: 2, classNo: 3 });
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

  const createPack = async (user: AuthUser, count = 5) => {
    const packId = (
      await call(user, 'POST', '/packs', { name: `오답 ${newId().slice(-8)}` })
    ).json().packId as string;
    await call(user, 'POST', `/packs/${packId}/words`, {
      words: Array.from({ length: count }, (_, i) => ({
        english: `word${i}`,
        meanings: [`뜻${i}`],
      })),
    });
    return packId;
  };

  const start = async (user: AuthUser, body: object) => {
    const res = await call(user, 'POST', '/study/sessions', {
      mode: 'CHOICE',
      direction: 'EN_TO_KO',
      shuffle: false,
      force: true,
      ...body,
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { sessionId: string; questions: Question[] };
  };

  /** wrongWords에 든 단어는 틀리고 나머지는 맞힌 뒤 끝낸다 */
  const play = async (
    user: AuthUser,
    session: { sessionId: string; questions: Question[] },
    wrongWords: string[],
    mode = 'CHOICE',
  ) => {
    for (const q of session.questions) {
      const wrong = wrongWords.includes(q.wordId);
      const right = q.answerIndex as number;
      await call(user, 'POST', `/study/sessions/${session.sessionId}/answers`, {
        index: q.index,
        elapsedMs: 2000,
        ...(mode === 'CHOICE'
          ? { choiceIndex: wrong ? (right + 1) % 4 : right }
          : { typedAnswer: wrong ? '모름' : `뜻${q.index}` }),
      });
    }
    return (
      await call(user, 'POST', `/study/sessions/${session.sessionId}/complete`, {
        reason: 'FINISHED',
      })
    ).json() as { recordId: string; xp: { earned: number } };
  };

  const list = async (user: AuthUser, query = '') => {
    const res = await call(user, 'GET', `/wrong-notes${query}`);
    expect(res.statusCode).toBe(200);
    return res.json() as { items: Note[]; nextCursor: string | null };
  };
  const label = (n: Note) => `${n.word.english}/${n.questionType}`;

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

  it('목록·필터·정렬·페이징', async () => {
    const user = await makeUser();
    const other = await makeUser();
    const packId = await createPack(user);
    const first = await start(user, { source: 'PACK', packId });
    const [w0, w1, w2] = first.questions.map((q) => q.wordId) as [string, string, string];
    const { recordId } = await play(user, first, [w0, w1, w2]);
    await play(user, await start(user, { source: 'PACK', packId, mode: 'TYPING' }), [w0], 'TYPING');
    await play(user, await start(user, { source: 'PACK', packId }), [w0]);

    // 최근 순서를 확실히 하려고 마지막으로 틀린 시각을 고정한다
    const order = [`word2`, 'word1', 'word0/T', 'word0/C'];
    for (const [i, key] of order.entries()) {
      const [english, type] = key.split('/');
      const questionType = type === 'T' ? 'EN_TO_KO_TYPING' : 'EN_TO_KO_CHOICE';
      const [word] = await db
        .select({ id: words.id })
        .from(words)
        .where(and(eq(words.packId, packId), eq(words.english, english as string)));
      await db
        .update(wrongNotes)
        .set({ lastWrongAt: new Date(Date.now() - (order.length - i) * 1000) })
        .where(
          and(eq(wrongNotes.wordId, word?.id as string), eq(wrongNotes.questionType, questionType)),
        );
    }

    const all = await list(user);
    expect(all.items.map(label)).toEqual([
      'word0/EN_TO_KO_CHOICE',
      'word0/EN_TO_KO_TYPING',
      'word1/EN_TO_KO_CHOICE',
      'word2/EN_TO_KO_CHOICE',
    ]);
    expect(all.items[0]).toMatchObject({
      pack: { packId },
      source: 'STUDY',
      wrongCount: 2,
      consecutiveCorrect: 0,
      word: { memoryStatus: 'LEARNING' },
    });

    const page1 = await list(user, '?size=3');
    const page2 = await list(user, `?size=3&cursor=${page1.nextCursor}`);
    expect([...page1.items, ...page2.items].map(label)).toEqual(all.items.map(label));
    expect(page2.nextCursor).toBeNull();

    expect((await list(user, '?questionType=EN_TO_KO_TYPING')).items.map(label)).toEqual([
      'word0/EN_TO_KO_TYPING',
    ]);
    expect((await list(user, '?sort=MOST_WRONG&size=1')).items.map(label)).toEqual([
      'word0/EN_TO_KO_CHOICE',
    ]);
    expect((await list(user, `?recordId=${recordId}`)).items.map(label).sort()).toEqual([
      'word0/EN_TO_KO_CHOICE',
      'word1/EN_TO_KO_CHOICE',
      'word2/EN_TO_KO_CHOICE',
    ]);
    expect((await list(other, `?recordId=${recordId}`)).items).toEqual([]);
    expect((await list(user, `?packId=${packId}&source=STUDY`)).items).toHaveLength(4);
    expect((await list(user, `?from=${today}&to=${today}`)).items).toHaveLength(4);
    expect((await list(user, `?from=${shift(1)}`)).items).toEqual([]);
    expect((await list(user, `?to=${shift(-1)}`)).items).toEqual([]);
    expect((await call(user, 'GET', `/wrong-notes?from=${today}&to=${shift(-1)}`)).statusCode).toBe(
      400,
    );
    expect((await list(other)).items).toEqual([]);
  });

  it('일괄 졸업·삭제는 내 것만, 삭제된 단어는 빠지고 삭제된 팩은 pack=null', async () => {
    const user = await makeUser();
    const other = await makeUser();
    const packId = await createPack(user);
    const session = await start(user, { source: 'PACK', packId });
    await play(
      user,
      session,
      session.questions.slice(0, 4).map((q) => q.wordId),
    );

    const otherPack = await createPack(other);
    const otherSession = await start(other, { source: 'PACK', packId: otherPack });
    await play(other, otherSession, [otherSession.questions[0]?.wordId as string]);
    const otherNote = (await list(other)).items[0]?.wrongNoteId as string;

    const ids = (await list(user)).items.map((n) => n.wrongNoteId);
    const graduated = await call(user, 'POST', '/wrong-notes/graduate', {
      wrongNoteIds: [ids[0], otherNote],
    });
    expect(graduated.json()).toEqual({ graduated: 1 });
    expect(
      (await call(user, 'POST', '/wrong-notes/graduate', { wrongNoteIds: [ids[0]] })).json(),
    ).toEqual({ graduated: 0 });
    expect((await list(user)).items).toHaveLength(3);
    expect((await list(user, '?status=GRADUATED')).items.map((n) => n.wrongNoteId)).toEqual([
      ids[0],
    ]);

    const deleted = await call(user, 'POST', '/wrong-notes/delete', {
      wrongNoteIds: [ids[1], otherNote],
    });
    expect(deleted.json()).toEqual({ deleted: 1 });
    expect((await list(other)).items).toHaveLength(1);
    expect((await call(user, 'POST', '/wrong-notes/delete', { wrongNoteIds: [] })).statusCode).toBe(
      400,
    );

    const remaining = (await list(user)).items;
    expect(remaining).toHaveLength(2);
    await call(user, 'DELETE', `/packs/${packId}/words/${remaining[0]?.word.wordId}`);
    expect((await list(user)).items).toHaveLength(1);
    await call(user, 'DELETE', `/packs/${packId}`);
    expect((await list(user)).items[0]?.pack).toBeNull();
  });

  it('오답노트로 다시 풀기: 단어마다 한 번, 정답 XP +1, 2번 연속 맞히면 졸업', async () => {
    const user = await makeUser();
    const packId = await createPack(user);
    const first = await start(user, { source: 'PACK', packId });
    const [w0, w1, w2] = first.questions.map((q) => q.wordId) as [string, string, string];
    await play(user, first, [w0, w1, w2]);
    await play(user, await start(user, { source: 'PACK', packId, mode: 'TYPING' }), [w0], 'TYPING');

    const review = await start(user, { source: 'WRONG_NOTE' });
    expect(review.questions.map((q) => q.wordId).sort()).toEqual([w0, w1, w2].sort());
    const picked = await start(user, { source: 'WRONG_NOTE', wordIds: [w1] });
    expect(picked.questions.map((q) => q.wordId)).toEqual([w1]);

    const result = await play(user, await start(user, { source: 'WRONG_NOTE' }), []);
    expect(result.xp.earned).toBe(3);
    const sources = (
      await db
        .select({ source: xpLedger.source })
        .from(xpLedger)
        .where(eq(xpLedger.userId, user.userId))
    ).map((r) => r.source);
    expect(sources).toContain('WRONG_NOTE_REVIEW');

    // 4지선다로 두 번째 연속 정답 → 4지선다 오답은 졸업, 직접 입력 오답은 남음
    await play(user, await start(user, { source: 'WRONG_NOTE' }), []);
    expect((await list(user)).items.map(label)).toEqual(['word0/EN_TO_KO_TYPING']);
    expect((await list(user, '?status=GRADUATED')).items).toHaveLength(3);
  });
});
