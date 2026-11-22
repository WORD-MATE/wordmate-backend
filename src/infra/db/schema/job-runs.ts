import { datetime, index, json, mysqlEnum, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { JOB, JOB_RUN_STATUS, JOB_TRIGGER } from '../../../common/enums.js';
import { id } from '../columns.js';

/** 정기 작업 실행 기록. 7일 지나면 매일 정리에서 지운다 */
export const jobRuns = mysqlTable(
  'job_runs',
  {
    id: id(),
    job: mysqlEnum('job', JOB).notNull(),
    status: mysqlEnum('status', JOB_RUN_STATUS).notNull(),
    trigger: mysqlEnum('trigger', JOB_TRIGGER).notNull(),
    startedAt: datetime('started_at', { mode: 'date', fsp: 3 }).notNull(),
    finishedAt: datetime('finished_at', { mode: 'date', fsp: 3 }),
    error: varchar('error', { length: 1000 }),
    result: json('result'),
  },
  (t) => [index('job_runs_job_idx').on(t.job, t.id), index('job_runs_started_idx').on(t.startedAt)],
);
