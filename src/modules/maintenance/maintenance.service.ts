import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { type Database, DB } from '../../infra/db/db.module.js';
import {
  jobRuns,
  notifications,
  practiceSessions,
  studySessions,
  wordFavorites,
  words,
} from '../../infra/db/schema/index.js';
import { NOTIFICATION_RETENTION_DAYS } from '../notifications/notification-rules.js';

/** 끝났거나 버린 학습 세션(문항·답안)을 남겨 두는 기간. 학습 기록(study_records)은 지우지 않는다 */
export const ENDED_SESSION_RETENTION_DAYS = 7;
const BATCH = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 한 번에 오래 잠그지 않도록 BATCH개씩 끝날 때까지 반복한다 */
/** 정기 작업 실행 기록 보관 기간 */
const JOB_RUN_RETENTION_DAYS = 7;

async function inBatches(run: () => Promise<number>): Promise<number> {
  let total = 0;
  for (;;) {
    const affected = await run();
    total += affected;
    if (affected < BATCH) return total;
  }
}

@Injectable()
export class MaintenanceService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** 마지막 답 이후 이어하기 보관 기간이 지난 학습을 버린다 (조회에서는 이미 만료로 보지만 active_key를 비워 둔다) */
  async expireStudySessions(now = new Date()): Promise<number> {
    const [result] = await this.db
      .update(studySessions)
      .set({ status: 'ABANDONED' })
      .where(and(eq(studySessions.status, 'IN_PROGRESS'), lt(studySessions.expiresAt, now)));
    return result.affectedRows;
  }

  async purgeEndedSessions(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - ENDED_SESSION_RETENTION_DAYS * DAY_MS);
    return inBatches(async () => {
      const rows = await this.db
        .select({ id: studySessions.id })
        .from(studySessions)
        .where(
          and(
            inArray(studySessions.status, ['COMPLETED', 'ABANDONED']),
            lt(studySessions.updatedAt, before),
          ),
        )
        .limit(BATCH);
      if (rows.length === 0) return 0;
      const [result] = await this.db.delete(studySessions).where(
        inArray(
          studySessions.id,
          rows.map((row) => row.id),
        ),
      );
      return result.affectedRows;
    });
  }

  /** 연습은 기록 화면이 없어 학습 세션과 같은 기간이 지나면 끝냈든 아니든 지운다 (오답노트는 이미 남아 있다) */
  async purgePracticeSessions(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - ENDED_SESSION_RETENTION_DAYS * DAY_MS);
    return inBatches(async () => {
      const rows = await this.db
        .select({ id: practiceSessions.id })
        .from(practiceSessions)
        .where(lt(practiceSessions.createdAt, before))
        .limit(BATCH);
      if (rows.length === 0) return 0;
      const [result] = await this.db.delete(practiceSessions).where(
        inArray(
          practiceSessions.id,
          rows.map((row) => row.id),
        ),
      );
      return result.affectedRows;
    });
  }

  /** 알림 목록은 30일만 보관한다 */
  async purgeNotifications(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * DAY_MS);
    return inBatches(async () => {
      const rows = await this.db
        .select({ id: notifications.id })
        .from(notifications)
        .where(lt(notifications.createdAt, before))
        .limit(BATCH);
      if (rows.length === 0) return 0;
      const [result] = await this.db.delete(notifications).where(
        inArray(
          notifications.id,
          rows.map((row) => row.id),
        ),
      );
      return result.affectedRows;
    });
  }

  /** 정기 작업 실행 기록은 7일만 둔다 (학습 리마인더가 매분 돌아 많이 쌓인다) */
  async purgeJobRuns(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - JOB_RUN_RETENTION_DAYS * DAY_MS);
    return inBatches(async () => {
      const rows = await this.db
        .select({ id: jobRuns.id })
        .from(jobRuns)
        .where(lt(jobRuns.startedAt, before))
        .limit(BATCH);
      if (rows.length === 0) return 0;
      const [result] = await this.db.delete(jobRuns).where(
        inArray(
          jobRuns.id,
          rows.map((row) => row.id),
        ),
      );
      return result.affectedRows;
    });
  }

  /** 삭제된 단어의 즐겨찾기는 목록에 나오지 않으므로 지운다 */
  async purgeDeletedWordFavorites(): Promise<number> {
    const [result] = await this.db.execute(sql`
      DELETE ${wordFavorites} FROM ${wordFavorites}
      JOIN ${words} ON ${words.id} = ${wordFavorites.wordId}
      WHERE ${isNotNull(words.deletedAt)}
    `);
    return (result as unknown as { affectedRows: number }).affectedRows;
  }
}
