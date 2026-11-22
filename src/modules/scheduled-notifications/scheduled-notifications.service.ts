import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { WEEKDAY } from '../../common/enums.js';
import { kstDate, kstTime } from '../../common/time/kst.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import {
  dailyStudyStats,
  morningCompletions,
  morningSentences,
  notificationSettings,
  rankingSeasons,
  rankingSnapshots,
  users,
} from '../../infra/db/schema/index.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { morningDate } from '../morning/morning-rules.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { periodKey, previousPeriodDate, xpOfScore } from '../ranking/ranking-keys.js';

/** 주간 반 순위가 이만큼 이상 내려가면 알린다 (임시값) */
export const RANK_DROP_MIN_PLACES = 3;
/** 같은 작업이 다시 돌아도(재시도·서버 여러 대) 한 번만 보내도록 남겨 두는 시간 */
const ONCE_TTL_SECONDS = 8 * 24 * 60 * 60;

const weekdayOf = (date: string) =>
  WEEKDAY[Temporal.PlainDate.from(date).dayOfWeek - 1] as (typeof WEEKDAY)[number];

@Injectable()
export class ScheduledNotificationsService {
  private readonly logger = new Logger(ScheduledNotificationsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * 매분. 이 시각·요일로 리마인더를 정한 사용자 가운데 오늘(KST) 아직 학습하지 않은 사람에게 한 번.
   * 계정 단위 설정이라 기기가 여러 대여도 알림은 하나이고, 푸시는 기기마다 간다
   */
  async studyReminders(now = new Date()): Promise<number> {
    const today = kstDate(now);
    const time = kstTime(now);
    return this.onceRun(`noti:reminder:${today}:${time}`, async () => {
      const candidates = await this.db
        .select({ userId: notificationSettings.userId })
        .from(notificationSettings)
        .where(
          and(
            eq(notificationSettings.reminderTime, time),
            sql`JSON_CONTAINS(${notificationSettings.reminderWeekdays}, JSON_QUOTE(${weekdayOf(today)}))`,
          ),
        );
      if (candidates.length === 0) return 0;
      const ids = candidates.map((c) => c.userId);
      const studied = new Set(
        (
          await this.db
            .select({ userId: dailyStudyStats.userId })
            .from(dailyStudyStats)
            .where(
              and(
                inArray(dailyStudyStats.userId, ids),
                eq(dailyStudyStats.date, today),
                gt(dailyStudyStats.sessionsCompleted, 0),
              ),
            )
        ).map((row) => row.userId),
      );
      const stored = await this.notifications.notify(
        ids.filter((id) => !studied.has(id)),
        {
          type: 'STUDY_REMINDER',
          title: '학습 시간이에요',
          body: '오늘의 단어 학습을 시작해 볼까요?',
          route: '/study',
        },
      );
      return stored.length;
    });
  }

  /** 06:00. 오늘(이전 포함) 날짜의 예약된 문장을 게시한다 */
  async publishMorning(now = new Date()): Promise<number> {
    const [result] = await this.db
      .update(morningSentences)
      .set({ status: 'PUBLISHED' })
      .where(
        and(
          eq(morningSentences.status, 'SCHEDULED'),
          lte(morningSentences.publishDate, morningDate(now)),
        ),
      );
    return result.affectedRows;
  }

  /** 07:00. 오늘 게시된 문장이 있을 때만, 아직 풀지 않은 학생에게 */
  async morningSentence(now = new Date()): Promise<number> {
    const today = morningDate(now);
    const [sentence] = await this.db
      .select({ id: morningSentences.id, sentence: morningSentences.sentence })
      .from(morningSentences)
      .where(
        and(eq(morningSentences.publishDate, today), eq(morningSentences.status, 'PUBLISHED')),
      );
    if (!sentence) return 0;
    return this.onceRun(`noti:morning:${today}`, async () => {
      const done = new Set(
        (
          await this.db
            .select({ userId: morningCompletions.userId })
            .from(morningCompletions)
            .where(eq(morningCompletions.sentenceId, sentence.id))
        ).map((row) => row.userId),
      );
      const students = await this.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.role, 'STUDENT'), eq(users.status, 'ACTIVE')));
      const stored = await this.notifications.notify(
        students.map((s) => s.id).filter((id) => !done.has(id)),
        {
          type: 'MORNING_SENTENCE',
          title: '오늘의 문장',
          body: sentence.sentence,
          route: '/morning',
        },
      );
      return stored.length;
    });
  }

  /** 월요일 08:00. 지난주 시즌이 확정됐으면 지난주 학교 순위를 알린다 */
  async weeklyRankResult(now = new Date()): Promise<number> {
    const lastWeek = periodKey('WEEKLY', previousPeriodDate('WEEKLY', kstDate(now)) as string);
    const [season] = await this.db
      .select({ id: rankingSeasons.id, status: rankingSeasons.status })
      .from(rankingSeasons)
      .where(and(eq(rankingSeasons.period, 'WEEKLY'), eq(rankingSeasons.periodKey, lastWeek)));
    if (season?.status !== 'CONFIRMED') {
      this.logger.warn(`지난주(${lastWeek}) 시즌이 확정되지 않아 주간 결과 알림을 보내지 않음`);
      return 0;
    }
    return this.onceRun(`noti:rank-weekly:${lastWeek}`, async () => {
      const rows = await this.db
        .select({
          userId: rankingSnapshots.userId,
          rank: rankingSnapshots.rank,
          xp: rankingSnapshots.xp,
        })
        .from(rankingSnapshots)
        .where(and(eq(rankingSnapshots.seasonId, season.id), eq(rankingSnapshots.scope, 'school')));
      let sent = 0;
      for (const row of rows) {
        sent += (
          await this.notifications.notify([row.userId], {
            type: 'RANK_WEEKLY_RESULT',
            title: '지난주 랭킹 결과',
            body: `지난주 학교 ${row.rank}위로 마감했어요. (${row.xp} XP)`,
            route: '/ranking',
          })
        ).length;
      }
      return sent;
    });
  }

  /**
   * 매일 20:00. 이번 주 반 순위를 지난 확인 때와 비교해 RANK_DROP_MIN_PLACES 이상 내려간 학생에게 알린다.
   * 주의 첫 확인은 기준만 남긴다
   */
  async rankDrops(now = new Date()): Promise<number> {
    const week = periodKey('WEEKLY', kstDate(now));
    return this.onceRun(`noti:rank-drop:${kstDate(now)}`, async () => {
      const stateKey = `noti:rank-drop:ranks:${week}`;
      const previous = await this.valkey.hgetall(stateKey);
      const current: Record<string, string> = {};
      const dropped: string[] = [];
      for (const key of await this.scan(`rank:weekly:${week}:class:*`)) {
        const flat = await this.valkey.zrevrange(key, 0, -1, 'WITHSCORES');
        let rank = 0;
        for (let i = 0; i < flat.length; i += 2) {
          if (xpOfScore(Number(flat[i + 1])) <= 0) continue;
          rank++;
          const userId = flat[i] as string;
          current[userId] = String(rank);
          const before = Number(previous[userId] ?? 0);
          if (before > 0 && rank - before >= RANK_DROP_MIN_PLACES) dropped.push(userId);
        }
      }
      if (Object.keys(current).length > 0) {
        await this.valkey.multi().hset(stateKey, current).expire(stateKey, ONCE_TTL_SECONDS).exec();
      }
      let sent = 0;
      for (const userId of dropped) {
        sent += (
          await this.notifications.notify([userId], {
            type: 'RANK_DROP',
            title: '순위가 내려갔어요',
            body: `이번 주 반 순위가 ${previous[userId]}위에서 ${current[userId]}위로 내려갔어요.`,
            route: '/ranking',
          })
        ).length;
      }
      return sent;
    });
  }

  /** 같은 키로는 한 번만 실행한다. 실패하면 키를 지워 재시도가 다시 보내게 한다 */
  private async onceRun(key: string, run: () => Promise<number>): Promise<number> {
    if ((await this.valkey.set(key, '1', 'EX', ONCE_TTL_SECONDS, 'NX')) !== 'OK') return 0;
    try {
      return await run();
    } catch (error) {
      await this.valkey.del(key);
      throw error;
    }
  }

  private async scan(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.valkey.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');
    return keys;
  }
}
