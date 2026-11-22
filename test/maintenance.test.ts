import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Job, Queue } from 'bullmq';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
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
  wordFavorites,
  words,
  wrongNotes,
  xpLedger,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import {
  MAINTENANCE_QUEUE,
  MaintenanceJob,
  MaintenanceProcessor,
} from '../src/modules/maintenance/maintenance.processor.js';
import { MaintenanceService } from '../src/modules/maintenance/maintenance.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('정리 작업', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let maintenance: MaintenanceService;
  const userIds: string[] = [];

  const makeUser = async (): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    await db
      .insert(users)
      .values({ id: userId, name: '정리유저', role: 'STUDENT', grade: 1, classNo: 1 });
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

  const createPack = async (user: AuthUser) => {
    const packId = (
      await call(user, 'POST', '/packs', { name: `정리 ${newId().slice(-8)}` })
    ).json().packId as string;
    await call(user, 'POST', `/packs/${packId}/words`, {
      words: Array.from({ length: 4 }, (_, i) => ({ english: `word${i}`, meanings: [`뜻${i}`] })),
    });
    return packId;
  };

  const start = async (user: AuthUser, packId: string) =>
    (
      await call(user, 'POST', '/study/sessions', {
        source: 'PACK',
        packId,
        mode: 'FLASHCARD',
        direction: 'EN_TO_KO',
        shuffle: false,
        force: true,
      })
    ).json().sessionId as string;

  const statusOf = async (sessionId: string) =>
    (
      await db
        .select({ status: studySessions.status })
        .from(studySessions)
        .where(eq(studySessions.id, sessionId))
    )[0]?.status;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    maintenance = app.get(MaintenanceService);
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
      wordFavorites,
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

  it('앱이 뜨면 정리 작업 스케줄이 등록된다', async () => {
    const queue = app.get<Queue>(getQueueToken(MAINTENANCE_QUEUE));
    // 스케줄 등록은 앱 시작을 막지 않도록 백그라운드에서 한다
    await expect
      .poll(async () => (await queue.getJobSchedulers()).map((s) => s.key).sort(), {
        timeout: 5000,
      })
      .toEqual([MaintenanceJob.dailyCleanup, MaintenanceJob.expireSessions].sort());
  });

  it('만료된 이어하기는 버리고, 끝난 지 7일 지난 세션은 지운다 (기록은 남음)', async () => {
    const user = await makeUser();
    const packId = await createPack(user);
    const expired = await start(user, packId);
    await db
      .update(studySessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(studySessions.id, expired));
    expect(await maintenance.expireStudySessions()).toBeGreaterThanOrEqual(1);
    expect(await statusOf(expired)).toBe('ABANDONED');

    const fresh = await start(user, packId);
    await call(user, 'POST', `/study/sessions/${fresh}/answers`, {
      index: 0,
      known: true,
      elapsedMs: 2000,
    });
    const { recordId } = (
      await call(user, 'POST', `/study/sessions/${fresh}/complete`, { reason: 'FINISHED' })
    ).json();
    const recent = await start(user, packId);
    await call(user, 'DELETE', `/study/sessions/${recent}`);

    const old = new Date(Date.now() - 8 * DAY_MS);
    await db
      .update(studySessions)
      .set({ updatedAt: old })
      .where(inArray(studySessions.id, [expired, fresh]));
    await maintenance.purgeEndedSessions();

    expect(await statusOf(expired)).toBeUndefined();
    expect(await statusOf(fresh)).toBeUndefined();
    expect(await statusOf(recent)).toBe('ABANDONED');
    const [record] = await db.select().from(studyRecords).where(eq(studyRecords.id, recordId));
    expect(record?.sessionId).toBeNull();
    expect((await call(user, 'GET', `/records/${recordId}`)).json().items).toHaveLength(1);
  });

  it('매일 정리를 돌려도 학습 기록은 지우지 않는다', async () => {
    const user = await makeUser();
    const base = Date.now() - 400 * DAY_MS;
    const rows = Array.from({ length: 60 }, (_, i) => ({
      id: newId(),
      userId: user.userId,
      source: 'PACK' as const,
      mode: 'CHOICE' as const,
      direction: 'EN_TO_KO' as const,
      reason: 'FINISHED' as const,
      correctCount: 1,
      wrongCount: 0,
      xpEarned: 1,
      packCompleteBonus: false,
      completedAt: new Date(base + i * DAY_MS),
      completedDate: '2025-01-01',
    }));
    await db.insert(studyRecords).values(rows);
    await db.insert(studyRecordItems).values({
      recordId: rows[0]?.id as string,
      idx: 0,
      wordId: newId(),
      english: 'old',
      meanings: ['오래됨'],
      correct: true,
    });

    const processor = app.get(MaintenanceProcessor);
    const result = await processor.process({ name: MaintenanceJob.dailyCleanup } as Job);
    expect(Object.keys(result).sort()).toEqual([
      'expiredSessions',
      'purgedFavorites',
      'purgedJobRuns',
      'purgedNotifications',
      'purgedPractices',
      'purgedSessions',
    ]);
    await expect(processor.process({ name: 'unknown-job' } as Job)).rejects.toThrow('unknown-job');
    expect(
      await db.select().from(studyRecords).where(eq(studyRecords.userId, user.userId)),
    ).toHaveLength(60);
    expect(
      await db
        .select()
        .from(studyRecordItems)
        .where(eq(studyRecordItems.recordId, rows[0]?.id as string)),
    ).toHaveLength(1);
  });

  it('삭제된 단어의 즐겨찾기를 지운다', async () => {
    const user = await makeUser();
    const packId = await createPack(user);
    const items = (await call(user, 'GET', `/packs/${packId}/words`)).json().items as {
      wordId: string;
    }[];
    const [gone, kept] = items.map((w) => w.wordId) as [string, string];
    await call(user, 'PUT', `/words/${gone}/favorite`);
    await call(user, 'PUT', `/words/${kept}/favorite`);
    await call(user, 'DELETE', `/packs/${packId}/words/${gone}`);

    expect(await maintenance.purgeDeletedWordFavorites()).toBeGreaterThanOrEqual(1);
    const left = await db
      .select({ wordId: wordFavorites.wordId })
      .from(wordFavorites)
      .where(eq(wordFavorites.userId, user.userId));
    expect(left.map((f) => f.wordId)).toEqual([kept]);
  });
});
