import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NotificationType } from '../src/common/enums.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  dailyStudyStats,
  morningCompletions,
  morningSentences,
  notificationSettings,
  notifications,
  rankingSeasons,
  rankingSnapshots,
  users,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { applyMorningSeed } from '../src/modules/morning/seed/morning-seed.js';
import { encodeScore } from '../src/modules/ranking/ranking-keys.js';
import { ScheduledNotificationsService } from '../src/modules/scheduled-notifications/scheduled-notifications.service.js';
import { createTestApp } from './support/create-test-app.js';

// 다른 테스트와 겹치지 않는 먼 날짜 (2030-01-07 월요일)
const MONDAY = '2030-01-07';

describe('예약 알림', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let valkey: Redis;
  let service: ScheduledNotificationsService;
  const userIds: string[] = [];

  const makeStudent = async (grade = 9, classNo = 9) => {
    const id = newId();
    userIds.push(id);
    await db
      .insert(users)
      .values({ id, name: `예약${id.slice(-4)}`, role: 'STUDENT', grade, classNo });
    return id;
  };

  const typesOf = async (userId: string, type: NotificationType) =>
    db
      .select({ body: notifications.body, route: notifications.route })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.type, type)));

  const settingsFor = (userId: string, reminderTime: string, weekdays: string[]) =>
    db.insert(notificationSettings).values({
      userId,
      studyReminder: true,
      morningSentence: true,
      battle: true,
      ranking: true,
      notice: true,
      marketing: false,
      reminderTime,
      reminderWeekdays: weekdays as ('MON' | 'TUE')[],
    });

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    valkey = app.get(VALKEY);
    service = app.get(ScheduledNotificationsService);
  });

  afterAll(async () => {
    await db.delete(notifications).where(inArray(notifications.userId, userIds));
    await db.delete(morningSentences).where(eq(morningSentences.publishDate, '2030-01-08'));
    await db.delete(rankingSeasons).where(eq(rankingSeasons.periodKey, '2029-12-31'));
    await valkey.del('rank:weekly:2030-01-07:class:9-9');
    await app.close();
  });

  it('학습 리마인더: 정한 시각·요일에 오늘 학습하지 않은 사람에게 한 번', async () => {
    const [due, studied, otherDay, otherTime] = await Promise.all([
      makeStudent(),
      makeStudent(),
      makeStudent(),
      makeStudent(),
    ]);
    await settingsFor(due, '09:15', ['MON']);
    await settingsFor(studied, '09:15', ['MON', 'TUE']);
    await settingsFor(otherDay, '09:15', ['TUE']);
    await settingsFor(otherTime, '09:16', ['MON']);
    await db
      .insert(dailyStudyStats)
      .values({ userId: studied, date: MONDAY, sessionsCompleted: 1 });

    const at = new Date(`${MONDAY}T00:15:00Z`);
    await service.studyReminders(at);
    expect(await typesOf(due, 'STUDY_REMINDER')).toHaveLength(1);
    for (const id of [studied, otherDay, otherTime]) {
      expect(await typesOf(id, 'STUDY_REMINDER')).toEqual([]);
    }
    // 같은 분에 다시 돌아도 보내지 않는다
    expect(await service.studyReminders(at)).toBe(0);
    expect(await typesOf(due, 'STUDY_REMINDER')).toHaveLength(1);
  });

  it('오늘의 문장: 06:00에 예약 문장을 게시하고 07:00에 아직 풀지 않은 학생에게', async () => {
    const [done, todo] = await Promise.all([makeStudent(), makeStudent()]);
    const sixAm = new Date('2030-01-07T21:00:00Z');
    const sevenAm = new Date('2030-01-07T22:00:00Z');
    expect(await service.morningSentence(sevenAm)).toBe(0);

    await applyMorningSeed(db, {
      sentences: [
        {
          date: '2030-01-08',
          sentence: 'Practice makes perfect.',
          translation: '연습이 완벽을 만든다.',
          keywords: [{ english: 'practice', meanings: ['연습'], highlight: { start: 0, end: 8 } }],
          quizzes: [
            { type: 'FILL_BLANK', question: '_____ makes perfect.', answers: ['Practice'] },
          ],
        },
      ],
    });
    await db
      .update(morningSentences)
      .set({ status: 'SCHEDULED' })
      .where(eq(morningSentences.publishDate, '2030-01-08'));
    expect(await service.publishMorning(sixAm)).toBeGreaterThanOrEqual(1);
    const [sentence] = await db
      .select()
      .from(morningSentences)
      .where(eq(morningSentences.publishDate, '2030-01-08'));
    expect(sentence?.status).toBe('PUBLISHED');

    await db.insert(morningCompletions).values({
      userId: done,
      sentenceId: sentence?.id as string,
      correctCount: 1,
      total: 1,
      xpGranted: 0,
      completedAt: sixAm,
    });
    await service.morningSentence(sevenAm);
    expect(await typesOf(todo, 'MORNING_SENTENCE')).toEqual([
      { body: 'Practice makes perfect.', route: '/morning' },
    ]);
    expect(await typesOf(done, 'MORNING_SENTENCE')).toEqual([]);
    expect(await service.morningSentence(sevenAm)).toBe(0);
  });

  it('주간 랭킹 결과: 지난주 시즌이 확정됐을 때만 학교 순위를 알린다', async () => {
    const student = await makeStudent();
    const eightAm = new Date('2030-01-06T23:00:00Z');
    expect(await service.weeklyRankResult(eightAm)).toBe(0);

    const seasonId = newId();
    await db.insert(rankingSeasons).values({
      id: seasonId,
      period: 'WEEKLY',
      periodKey: '2029-12-31',
      startsOn: '2029-12-31',
      endsOn: '2030-01-07',
      status: 'CONFIRMED',
    });
    await db.insert(rankingSnapshots).values([
      { seasonId, scope: 'school', userId: student, rank: 2, xp: 120, listed: true },
      { seasonId, scope: 'class:9-9', userId: student, rank: 1, xp: 120, listed: true },
    ]);
    // 확정 전에는 한 번 표시를 남기지 않아 확정 뒤에 보낸다
    expect(await service.weeklyRankResult(eightAm)).toBeGreaterThanOrEqual(1);
    expect(await typesOf(student, 'RANK_WEEKLY_RESULT')).toEqual([
      { body: '지난주 학교 2위로 마감했어요. (120 XP)', route: '/ranking' },
    ]);
    expect(await service.weeklyRankResult(eightAm)).toBe(0);
  });

  it('순위 하락: 이번 주 반 순위가 기준 이상 내려가면 알린다 (첫 확인은 기준만)', async () => {
    const ids = await Promise.all(Array.from({ length: 5 }, () => makeStudent()));
    const [top, ...others] = ids as [string, ...string[]];
    const key = 'rank:weekly:2030-01-07:class:9-9';
    const at = new Date('2030-01-01T00:00:00Z');
    await valkey.zadd(
      key,
      encodeScore(100, at),
      top,
      ...others.flatMap((id, i) => [encodeScore(50 - i, at), id]),
    );
    expect(await service.rankDrops(new Date(`${MONDAY}T11:00:00Z`))).toBe(0);

    for (const id of others.slice(0, 3)) await valkey.zadd(key, encodeScore(200, at), id);
    await service.rankDrops(new Date('2030-01-08T11:00:00Z'));
    expect(await typesOf(top, 'RANK_DROP')).toEqual([
      {
        body: '이번 주 반 순위가 1위에서 4위로 내려갔어요.',
        route: '/ranking',
      },
    ]);
    for (const id of others) expect(await typesOf(id, 'RANK_DROP')).toEqual([]);
  });
});
