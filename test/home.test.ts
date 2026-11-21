import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  classes,
  dailyStudiedWords,
  dailyStudyStats,
  packs,
  studyRecords,
  studySessions,
  teacherClasses,
  userStreaks,
  users,
  userWordProgress,
  words,
  wrongNotes,
  xpLedger,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { RankingQueryService } from '../src/modules/ranking/ranking-query.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

type Question = { index: number; answerIndex: number | null };

describe('홈 화면', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];
  const defaultPackIds: string[] = [];

  const makeUser = async (role: 'STUDENT' | 'TEACHER' = 'STUDENT', isAdmin = false) => {
    const userId = newId();
    userIds.push(userId);
    await db.insert(users).values({
      id: userId,
      name: '홈유저',
      role,
      isAdmin,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 5 : null,
    });
    if (role === 'TEACHER' && !isAdmin) {
      const [someClass] = await db.select({ id: classes.id }).from(classes).limit(1);
      await db
        .insert(teacherClasses)
        .values({ teacherId: userId, classId: someClass?.id as string });
    }
    return { userId, role, isAdmin, deviceId: newId() } as AuthUser;
  };

  const call = async (
    target: NestFastifyApplication,
    user: AuthUser,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    payload?: object,
  ) =>
    inject(target, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await target.get(AccessTokenService).sign(user)}` },
    });
  const home = async (user: AuthUser, target = app) => {
    const res = await call(target, user, 'GET', '/home');
    expect(res.statusCode).toBe(200);
    return res.json();
  };

  const createPack = async (user: AuthUser) => {
    const packId = (
      await call(app, user, 'POST', '/packs', { name: `홈 ${newId().slice(-8)}` })
    ).json().packId as string;
    await call(app, user, 'POST', `/packs/${packId}/words`, {
      words: Array.from({ length: 4 }, (_, i) => ({ english: `word${i}`, meanings: [`뜻${i}`] })),
    });
    return packId;
  };

  const start = async (user: AuthUser, body: object) =>
    (
      await call(app, user, 'POST', '/study/sessions', {
        mode: 'CHOICE',
        direction: 'EN_TO_KO',
        shuffle: false,
        force: true,
        ...body,
      })
    ).json() as { sessionId: string; questions: Question[] };

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
    const ids = [...owned.map((row) => row.id), ...defaultPackIds];
    if (ids.length > 0) {
      await db.delete(words).where(inArray(words.packId, ids));
      await db.delete(packs).where(inArray(packs.id, ids));
    }
    await app.close();
  });

  it('처음 온 학생: 기본 단어팩 추천, 나머지는 비어 있는 값', async () => {
    const admin = await makeUser('TEACHER', true);
    const recommended = (
      await call(app, admin, 'POST', '/packs', {
        name: `추천팩 ${newId().slice(-6)}`,
        type: 'DEFAULT',
      })
    ).json();
    defaultPackIds.push(recommended.packId);
    // 다른 테스트가 남긴 기본 팩보다 앞에 오도록 추천 순서를 맨 앞으로
    await db.update(packs).set({ sortOrder: -1000 }).where(eq(packs.id, recommended.packId));

    const student = await makeUser();
    const body = await home(student);
    expect(body).toMatchObject({
      morning: null,
      review: { dueCount: 0 },
      continueStudy: null,
      streak: { current: 0, best: 0, todayDone: false },
      missions: null,
      myWeeklyRank: { rank: null, topPercent: null, xp: 0, change: null },
    });
    expect(body.recommendedPacks.length).toBeLessThanOrEqual(5);
    expect(body.recommendedPacks.map((p: { packId: string }) => p.packId)).toContain(
      recommended.packId,
    );
  });

  it('공부한 뒤: 이어할 학습·스트릭·주간 순위가 채워지고 추천은 빈 배열', async () => {
    const student = await makeUser();
    const packId = await createPack(student);
    const done = await start(student, { source: 'PACK', packId });
    for (const q of done.questions) {
      await call(app, student, 'POST', `/study/sessions/${done.sessionId}/answers`, {
        index: q.index,
        choiceIndex: q.answerIndex,
        elapsedMs: 2000,
      });
    }
    await call(app, student, 'POST', `/study/sessions/${done.sessionId}/complete`, {
      reason: 'FINISHED',
    });
    const ongoing = await start(student, { source: 'PACK', packId, mode: 'FLASHCARD' });
    await call(app, student, 'POST', `/study/sessions/${ongoing.sessionId}/answers`, {
      index: 0,
      known: true,
      elapsedMs: 2000,
    });

    const body = await home(student);
    expect(body.continueStudy).toMatchObject({
      sessionId: ongoing.sessionId,
      source: 'PACK',
      packId,
      packName: expect.stringMatching(/^홈 /),
      answered: 1,
      total: 4,
    });
    expect(body.streak).toEqual({ current: 1, best: 1, todayDone: true });
    expect(body.myWeeklyRank.xp).toBe(14);
    // 다른 테스트 사용자 수에 따라 100위 안이면 rank, 밖이면 topPercent
    expect(body.myWeeklyRank.rank ?? body.myWeeklyRank.topPercent).toEqual(expect.any(Number));
    expect(body.recommendedPacks).toEqual([]);

    // 팩이 없는 학습은 학습 종류 이름을 보여준다
    const fav = (await call(app, student, 'GET', `/packs/${packId}/words`)).json().items[0].wordId;
    await call(app, student, 'PUT', `/words/${fav}/favorite`);
    const favorite = await start(student, { source: 'FAVORITE', mode: 'FLASHCARD' });
    expect((await home(student)).continueStudy).toMatchObject({
      sessionId: favorite.sessionId,
      source: 'FAVORITE',
      packId: null,
      packName: '즐겨찾기',
    });
  });

  it('교사는 주간 순위가 null', async () => {
    const teacher = await makeUser('TEACHER');
    expect((await home(teacher)).myWeeklyRank).toBeNull();
  });

  it('한 칸을 불러오지 못해도 나머지는 내려준다', async () => {
    const broken = await createTestApp({
      overrides: [
        [
          RankingQueryService,
          {
            me: async () => {
              throw new Error('valkey down');
            },
          },
        ],
      ],
    });
    try {
      const student = await makeUser();
      const body = await home(student, broken);
      expect(body.myWeeklyRank).toBeNull();
      expect(body.streak).toEqual({ current: 0, best: 0, todayDone: false });
      expect(body.review).toEqual({ dueCount: 0 });
    } finally {
      await broken.close();
    }
  });
});
