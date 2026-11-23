import { Inject, Injectable } from '@nestjs/common';
import { and, count, eq, gte, inArray, lt, lte, ne, sql, sum } from 'drizzle-orm';
import type { SuspiciousReason } from '../../common/enums.js';
import { kstDayRange } from '../../common/time/kst.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import {
  battleDailyPairs,
  studyAnswers,
  studySessions,
  suspiciousFlags,
  xpLedger,
} from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { DAILY_XP_CAP } from '../xp/xp.service.js';
import {
  FAST_ANSWER_MIN_COUNT,
  fastAnswerEvidence,
  REPEATED_OPPONENT_MIN,
  repeatedOpponentEvidence,
  XP_SPIKE_LOOKBACK_DAYS,
  xpSpikeEvidence,
} from './suspicious-rules.js';

type Detected = { userId: string; reason: SuspiciousReason; detail: Record<string, unknown> };

@Injectable()
export class SuspiciousService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** 하루(KST) 활동을 보고 표시한다. 같은 날을 다시 돌려도 이미 있는 표시는 그대로 둔다 */
  async detect(date: string, now = new Date()) {
    const [fast, repeated, spike] = await Promise.all([
      this.fastAnswers(date),
      this.repeatedOpponents(date),
      this.xpSpikes(date),
    ]);
    const detected = [...fast, ...repeated, ...spike];
    let flagged = 0;
    if (detected.length > 0) {
      const [result] = await this.db
        .insert(suspiciousFlags)
        .ignore()
        .values(detected.map((d) => ({ id: newId(), ...d, date, detectedAt: now })));
      flagged = result.affectedRows;
    }
    return {
      date,
      fastAnswers: fast.length,
      repeatedOpponent: repeated.length,
      xpSpike: spike.length,
      flagged,
    };
  }

  private async fastAnswers(date: string): Promise<Detected[]> {
    const { start, end } = kstDayRange(date);
    const rows = await this.db
      .select({
        userId: studySessions.userId,
        answerCount: count(),
        fastCount: sql<string>`SUM(${studyAnswers.counted} = 0)`,
      })
      .from(studyAnswers)
      .innerJoin(studySessions, eq(studySessions.id, studyAnswers.sessionId))
      .where(and(gte(studyAnswers.submittedAt, start), lt(studyAnswers.submittedAt, end)))
      .groupBy(studySessions.userId)
      .having(gte(count(), FAST_ANSWER_MIN_COUNT));
    return rows.flatMap((row) => {
      const detail = fastAnswerEvidence(row.answerCount, Number(row.fastCount));
      return detail ? [{ userId: row.userId, reason: 'FAST_ANSWERS' as const, detail }] : [];
    });
  }

  private async repeatedOpponents(date: string): Promise<Detected[]> {
    const rows = await this.db
      .select()
      .from(battleDailyPairs)
      .where(
        and(eq(battleDailyPairs.date, date), gte(battleDailyPairs.count, REPEATED_OPPONENT_MIN)),
      );
    const byUser = Map.groupBy(rows, (row) => row.userId);
    return [...byUser].flatMap(([userId, pairs]) => {
      const detail = repeatedOpponentEvidence(pairs);
      return detail ? [{ userId, reason: 'REPEATED_OPPONENT' as const, detail }] : [];
    });
  }

  private async xpSpikes(date: string): Promise<Detected[]> {
    // 관리자 조정은 하루 상한에 넣지 않는다 (지급할 때와 같은 기준)
    const earned = sum(xpLedger.amount);
    const capped = await this.db
      .select({ userId: xpLedger.userId })
      .from(xpLedger)
      .where(and(eq(xpLedger.date, date), ne(xpLedger.source, 'ADMIN_ADJUST')))
      .groupBy(xpLedger.userId)
      .having(gte(earned, DAILY_XP_CAP));
    if (capped.length === 0) return [];
    const from = Temporal.PlainDate.from(date)
      .subtract({ days: XP_SPIKE_LOOKBACK_DAYS - 1 })
      .toString();
    const rows = await this.db
      .select({ userId: xpLedger.userId, date: xpLedger.date, xp: earned })
      .from(xpLedger)
      .where(
        and(
          inArray(
            xpLedger.userId,
            capped.map((c) => c.userId),
          ),
          gte(xpLedger.date, from),
          lte(xpLedger.date, date),
          ne(xpLedger.source, 'ADMIN_ADJUST'),
        ),
      )
      .groupBy(xpLedger.userId, xpLedger.date);
    const byUser = Map.groupBy(rows, (row) => row.userId);
    return [...byUser].flatMap(([userId, days]) => {
      const xpByDate = new Map(days.map((d) => [d.date, Number(d.xp ?? 0)]));
      const detail = xpSpikeEvidence(xpByDate, date, DAILY_XP_CAP);
      return detail ? [{ userId, reason: 'XP_SPIKE' as const, detail }] : [];
    });
  }
}
