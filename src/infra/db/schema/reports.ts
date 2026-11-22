import { char, index, mysqlEnum, mysqlTable, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { REPORT_REASON, REPORT_STATUS, REPORT_TARGET } from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { battles } from './battles.js';
import { users } from './users.js';

/** 신고. 대상은 종류마다 다른 테이블이라 FK를 걸지 않는다. 처리는 관리자 기능에서 한다 */
export const reports = mysqlTable(
  'reports',
  {
    id: id(),
    reporterId: binaryUuid('reporter_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    targetType: mysqlEnum('target_type', REPORT_TARGET).notNull(),
    targetId: binaryUuid('target_id').notNull(),
    reason: mysqlEnum('reason', REPORT_REASON).notNull(),
    detail: varchar('detail', { length: 200 }),
    battleId: binaryUuid('battle_id').references(() => battles.id, { onDelete: 'set null' }),
    status: mysqlEnum('status', REPORT_STATUS).notNull().default('RECEIVED'),
    // 같은 대상·사유는 하루(KST) 한 번. 유니크 키로 동시에 보내도 하나만 남긴다
    reportDate: char('report_date', { length: 10 }).notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex('reports_daily_uq').on(
      t.reporterId,
      t.targetType,
      t.targetId,
      t.reason,
      t.reportDate,
    ),
    index('reports_status_idx').on(t.status, t.id),
    index('reports_target_idx').on(t.targetType, t.targetId),
  ],
);
