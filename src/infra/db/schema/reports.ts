import {
  char,
  datetime,
  index,
  mysqlEnum,
  mysqlTable,
  tinyint,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import {
  REPORT_REASON,
  REPORT_RESULT,
  REPORT_STATUS,
  REPORT_TARGET,
} from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { battles } from './battles.js';
import { users } from './users.js';

/**
 * 같은 대상의 신고 묶음. 처리하면 닫고(openKey NULL), 그 뒤의 신고는 새 묶음이 된다.
 * (대상, openKey) 유니크라 열린 묶음은 대상마다 하나다 (NULL은 여러 개 허용)
 */
export const reportGroups = mysqlTable(
  'report_groups',
  {
    id: id(),
    targetType: mysqlEnum('target_type', REPORT_TARGET).notNull(),
    targetId: binaryUuid('target_id').notNull(),
    status: mysqlEnum('status', REPORT_STATUS).notNull().default('RECEIVED'),
    openKey: tinyint('open_key').default(1),
    result: mysqlEnum('result', REPORT_RESULT),
    memo: varchar('memo', { length: 1000 }),
    adminId: binaryUuid('admin_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: datetime('resolved_at', { mode: 'date', fsp: 3 }),
    lastReportedAt: datetime('last_reported_at', { mode: 'date', fsp: 3 }).notNull(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('report_groups_open_uq').on(t.targetType, t.targetId, t.openKey),
    index('report_groups_status_idx').on(t.status, t.lastReportedAt),
  ],
);

export type ReportGroup = typeof reportGroups.$inferSelect;

/** 처리 결과를 바꿀 때마다 남기는 이력 */
export const reportGroupHistory = mysqlTable(
  'report_group_history',
  {
    id: id(),
    groupId: binaryUuid('group_id')
      .notNull()
      .references(() => reportGroups.id, { onDelete: 'cascade' }),
    status: mysqlEnum('status', REPORT_STATUS).notNull(),
    result: mysqlEnum('result', REPORT_RESULT),
    memo: varchar('memo', { length: 1000 }),
    adminId: binaryUuid('admin_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('report_group_history_group_idx').on(t.groupId, t.id)],
);

/** 신고. 대상은 종류마다 다른 테이블이라 FK를 걸지 않는다. 처리는 관리자 기능에서 한다 */
export const reports = mysqlTable(
  'reports',
  {
    id: id(),
    groupId: binaryUuid('group_id')
      .notNull()
      .references(() => reportGroups.id, { onDelete: 'cascade' }),
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
    index('reports_group_idx').on(t.groupId, t.id),
  ],
);
