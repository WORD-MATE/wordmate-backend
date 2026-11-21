import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
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
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { RankingService } from '../src/modules/ranking/ranking.service.js';
import { rankKey, xpOfScore } from '../src/modules/ranking/ranking-keys.js';
import { createTestApp, inject } from './support/create-test-app.js';

type Question = { index: number; answerIndex: number | null };

describe('랭킹 점수 집계', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let valkey: Redis;
  let ranking: RankingService;
  const userIds: string[] = [];
  const today = kstDate();
  const keysFor = (grade: number, classNo: number) =>
    (['WEEKLY', 'MONTHLY', 'ALL'] as const).flatMap((period) =>
      ['school', `grade:${grade}`, `class:${grade}-${classNo}`].map((scope) =>
        rankKey(period, today, scope),
      ),
    );

  const makeUser = async (role: 'STUDENT' | 'TEACHER' = 'STUDENT', grade = 2, classNo = 3) => {
    const userId = newId();
    userIds.push(userId);
    await db.insert(users).values({
      id: userId,
      name: '랭킹유저',
      role,
      grade: role === 'STUDENT' ? grade : null,
      classNo: role === 'STUDENT' ? classNo : null,
    });
    return { userId, role, isAdmin: false, deviceId: newId() } as AuthUser;
  };

  const call = async (user: AuthUser, method: 'GET' | 'POST', url: string, payload?: object) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  /** 4단어 팩을 4지선다로 다 맞히고 끝낸다 → 정답 4 + 완주 10 = 14 XP (같은 팩은 하루 1회 보너스) */
  const studyOnce = async (user: AuthUser) => {
    const packId = (
      await call(user, 'POST', '/packs', { name: `랭킹 ${newId().slice(-8)}` })
    ).json().packId as string;
    await call(user, 'POST', `/packs/${packId}/words`, {
      words: Array.from({ length: 4 }, (_, i) => ({ english: `word${i}`, meanings: [`뜻${i}`] })),
    });
    const started = await call(user, 'POST', '/study/sessions', {
      source: 'PACK',
      packId,
      mode: 'CHOICE',
      direction: 'EN_TO_KO',
      shuffle: false,
    });
    const { sessionId, questions } = started.json() as { sessionId: string; questions: Question[] };
    for (const q of questions) {
      await call(user, 'POST', `/study/sessions/${sessionId}/answers`, {
        index: q.index,
        choiceIndex: q.answerIndex,
        elapsedMs: 2000,
      });
    }
    return (
      await call(user, 'POST', `/study/sessions/${sessionId}/complete`, { reason: 'FINISHED' })
    ).json().xp.earned as number;
  };

  const xpIn = async (key: string, userId: string) => {
    const score = await valkey.zscore(key, userId);
    return score === null ? null : xpOfScore(Number(score));
  };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    valkey = app.get(VALKEY);
    ranking = app.get(RankingService);
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

  it('학습을 끝내면 누적 XP와 주간·월간·전체 × 학교·학년·반 점수가 오른다', async () => {
    const student = await makeUser('STUDENT', 2, 3);
    const first = await studyOnce(student);
    expect(first).toBe(14);
    for (const key of keysFor(2, 3)) {
      expect(await xpIn(key, student.userId)).toBe(14);
    }
    expect(await xpIn(rankKey('WEEKLY', today, 'class:2-4'), student.userId)).toBeNull();
    expect(await valkey.ttl(rankKey('WEEKLY', today, 'school'))).toBeGreaterThan(0);
    expect(await valkey.ttl(rankKey('ALL', today, 'school'))).toBe(-1);

    const second = await studyOnce(student);
    expect(await xpIn(rankKey('WEEKLY', today, 'school'), student.userId)).toBe(first + second);
    const [row] = await db
      .select({ totalXp: users.totalXp })
      .from(users)
      .where(eq(users.id, student.userId));
    expect(row?.totalXp).toBe(first + second);
  });

  it('교사는 랭킹에 들어가지 않는다 (누적 XP는 쌓임)', async () => {
    const teacher = await makeUser('TEACHER');
    await ranking.addXp(teacher.userId, 30);
    expect(await xpIn(rankKey('WEEKLY', today, 'school'), teacher.userId)).toBeNull();
  });

  it('XP가 같으면 먼저 그 점수에 도달한 사용자가 위', async () => {
    const early = await makeUser('STUDENT', 1, 9);
    const late = await makeUser('STUDENT', 1, 9);
    const key = rankKey('WEEKLY', today, 'class:1-9');
    await ranking.addXp(late.userId, 10, new Date(Date.now() - 60_000));
    await ranking.addXp(early.userId, 20, new Date(Date.now() - 50_000));
    // late가 나중에 20에 도달
    await ranking.addXp(late.userId, 10, new Date(Date.now() - 10_000));
    expect(await valkey.zrevrange(key, 0, -1)).toEqual([early.userId, late.userId]);
    expect(await xpIn(key, late.userId)).toBe(20);
  });

  it('원장에서 랭킹을 다시 만들면 같은 점수·순서로 돌아온다', async () => {
    const student = await makeUser('STUDENT', 3, 7);
    await studyOnce(student);
    const key = rankKey('MONTHLY', today, 'class:3-7');
    const before = await valkey.zscore(key, student.userId);

    await valkey.del(key);
    await valkey.zadd(rankKey('WEEKLY', today, 'class:3-99'), 1, 'stale-member');
    const counts = await ranking.rebuild();
    expect(counts.ALL).toBeGreaterThan(0);
    expect(await xpIn(key, student.userId)).toBe(xpOfScore(Number(before)));
    expect(await valkey.exists(rankKey('WEEKLY', today, 'class:3-99'))).toBe(0);
  });
});
