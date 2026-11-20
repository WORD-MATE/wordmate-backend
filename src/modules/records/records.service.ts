import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, countDistinct, desc, eq, gte, lt, lte, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException, CommonErrors } from '../../common/errors/app-exception.js';
import { type CursorPage, decodeCursor, toCursorPage } from '../../common/pagination.js';
import { kstDate } from '../../common/time/kst.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import {
  dailyStudiedWords,
  dailyStudyStats,
  packs,
  studyRecordItems,
  studyRecords,
  userStreaks,
} from '../../infra/db/schema/index.js';
import type {
  CalendarStats,
  RecordDetail,
  RecordListQuery,
  RecordSummary,
  SummaryStats,
} from './records.schemas.js';
import { accuracyOf, datesBetween, periodStart, streakView } from './stats.js';

export const RecordErrors = {
  notFound: () =>
    new AppException('RECORD_NOT_FOUND', '학습 기록을 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
  futureMonth: () => CommonErrors.invalidRequest({ field: 'month' }, '미래의 달은 볼 수 없습니다.'),
};

const RecordCursor = z.object({ at: z.iso.datetime(), id: z.uuid() });

const summaryColumns = {
  record: studyRecords,
  pack: { packId: packs.id, name: packs.name, deletedAt: packs.deletedAt },
};

type SummaryRow = {
  record: typeof studyRecords.$inferSelect;
  pack: { packId: string; name: string; deletedAt: Date | null } | null;
};

const toSummary = ({ record, pack }: SummaryRow): RecordSummary => {
  const live = pack && !pack.deletedAt ? pack : null;
  return {
    recordId: record.id,
    pack: { packId: live?.packId ?? null, name: live?.name ?? null },
    source: record.source,
    mode: record.mode,
    direction: record.direction,
    correctCount: record.correctCount,
    wrongCount: record.wrongCount,
    accuracy: record.accuracy,
    completedAt: record.completedAt.toISOString(),
  };
};

@Injectable()
export class RecordsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** 최신순 */
  async list(user: AuthUser, query: RecordListQuery): Promise<CursorPage<RecordSummary>> {
    const cursor = query.cursor && decodeCursor(query.cursor, RecordCursor);
    const at = cursor ? new Date(cursor.at) : null;
    const rows = await this.db
      .select(summaryColumns)
      .from(studyRecords)
      .leftJoin(packs, eq(packs.id, studyRecords.packId))
      .where(
        and(
          eq(studyRecords.userId, user.userId),
          query.date ? eq(studyRecords.completedDate, query.date) : undefined,
          cursor && at
            ? or(
                lt(studyRecords.completedAt, at),
                and(eq(studyRecords.completedAt, at), lt(studyRecords.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(studyRecords.completedAt), desc(studyRecords.id))
      .limit(query.size + 1);
    const page = toCursorPage(rows, query.size, (last) => ({
      at: last.record.completedAt.toISOString(),
      id: last.record.id,
    }));
    return { items: page.items.map(toSummary), nextCursor: page.nextCursor };
  }

  async detail(user: AuthUser, recordId: string): Promise<RecordDetail> {
    const [row] = await this.db
      .select(summaryColumns)
      .from(studyRecords)
      .leftJoin(packs, eq(packs.id, studyRecords.packId))
      .where(eq(studyRecords.id, recordId));
    if (!row) throw RecordErrors.notFound();
    if (row.record.userId !== user.userId) throw CommonErrors.forbidden();
    const items = await this.db
      .select()
      .from(studyRecordItems)
      .where(eq(studyRecordItems.recordId, recordId))
      .orderBy(asc(studyRecordItems.idx));
    return {
      ...toSummary(row),
      knownCount: row.record.knownCount,
      unknownCount: row.record.unknownCount,
      items: items.map((item) => ({
        index: item.idx,
        wordId: item.wordId,
        english: item.english,
        meanings: item.meanings,
        correct: item.correct,
        known: item.known,
        userAnswer: item.userAnswer,
      })),
    };
  }

  async streak(user: AuthUser) {
    const [state] = await this.db
      .select()
      .from(userStreaks)
      .where(and(eq(userStreaks.userId, user.userId), eq(userStreaks.kind, 'STUDY')));
    return streakView(state ?? null, kstDate());
  }

  async calendar(user: AuthUser, month: string): Promise<CalendarStats> {
    const thisMonth = kstDate().slice(0, 7);
    if (month > thisMonth) throw RecordErrors.futureMonth();
    const first = `${month}-01`;
    const next = Temporal.PlainDate.from(first).add({ months: 1 }).toString();
    const rows = await this.db
      .select({ date: dailyStudyStats.date, solvedCount: dailyStudyStats.solvedCount })
      .from(dailyStudyStats)
      .where(
        and(
          eq(dailyStudyStats.userId, user.userId),
          gte(dailyStudyStats.date, first),
          lt(dailyStudyStats.date, next),
        ),
      )
      .orderBy(asc(dailyStudyStats.date));
    return { month, days: rows.filter((row) => row.solvedCount > 0) };
  }

  /** 이번 주는 월요일부터, 이번 달은 1일부터 오늘까지 (KST) */
  async summary(user: AuthUser, period: SummaryStats['period']): Promise<SummaryStats> {
    const today = kstDate();
    const from = periodStart(period, today);
    const inRange = (column: typeof dailyStudyStats.date | typeof dailyStudiedWords.date): SQL =>
      and(gte(column, from), lte(column, today)) as SQL;

    const days = await this.db
      .select()
      .from(dailyStudyStats)
      .where(and(eq(dailyStudyStats.userId, user.userId), inRange(dailyStudyStats.date)));
    const [words] = await this.db
      .select({ total: countDistinct(dailyStudiedWords.wordId) })
      .from(dailyStudiedWords)
      .where(and(eq(dailyStudiedWords.userId, user.userId), inRange(dailyStudiedWords.date)));

    const total = days.reduce(
      (sum, day) => ({
        solved: sum.solved + day.solvedCount,
        graded: sum.graded + day.gradedCount,
        correct: sum.correct + day.correctCount,
      }),
      { solved: 0, graded: 0, correct: 0 },
    );
    const byDate = new Map(days.map((day) => [day.date, day]));
    return {
      period,
      studiedWordCount: words?.total ?? 0,
      solvedCount: total.solved,
      correctCount: total.correct,
      accuracy: accuracyOf(total.correct, total.graded),
      series:
        period === 'TODAY'
          ? []
          : datesBetween(from, today).map((date) => {
              const day = byDate.get(date);
              return {
                date,
                solvedCount: day?.solvedCount ?? 0,
                accuracy: day ? accuracyOf(day.correctCount, day.gradedCount) : null,
              };
            }),
    };
  }
}
