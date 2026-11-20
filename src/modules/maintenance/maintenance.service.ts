import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import { type Database, DB } from '../../infra/db/db.module.js';
import { studyRecords, studySessions, wordFavorites, words } from '../../infra/db/schema/index.js';

/** 끝났거나 버린 학습 세션(문항·답안)을 남겨 두는 기간. 기록(study_records)은 따로 남는다 */
export const ENDED_SESSION_RETENTION_DAYS = 7;
/** 사용자별로 남기는 학습 기록 수. 달력·통계는 daily_study_stats에 남는다 */
export const RECORDS_PER_USER = 50;
const BATCH = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 한 번에 오래 잠그지 않도록 BATCH개씩 끝날 때까지 반복한다 */
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

  /** 사용자별 최근 RECORDS_PER_USER개를 넘는 기록을 지운다 (문항별 결과는 CASCADE) */
  async trimStudyRecords(): Promise<number> {
    return inBatches(async () => {
      const [rows] = (await this.db.execute(sql`
        SELECT id FROM (
          SELECT ${studyRecords.id} AS id,
            ROW_NUMBER() OVER (
              PARTITION BY ${studyRecords.userId}
              ORDER BY ${studyRecords.completedAt} DESC, ${studyRecords.id} DESC
            ) AS rn
          FROM ${studyRecords}
        ) ranked
        WHERE rn > ${RECORDS_PER_USER}
        LIMIT ${BATCH}
      `)) as unknown as [{ id: Buffer }[]];
      if (rows.length === 0) return 0;
      const [result] = await this.db.execute(
        sql`DELETE FROM ${studyRecords} WHERE ${studyRecords.id} IN (${sql.join(
          rows.map((row) => sql`${row.id}`),
          sql`, `,
        )})`,
      );
      return (result as unknown as { affectedRows: number }).affectedRows;
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
