import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  datetime,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
} from 'drizzle-orm/mysql-core';
import { SUSPICIOUS_REASON } from '../../../common/enums.js';
import { id } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { users } from './users.js';

/** 부정 의심 표시. 감지만 하고 제재는 관리자가 정한다 */
export const suspiciousFlags = mysqlTable(
  'suspicious_flags',
  {
    id: id(),
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: mysqlEnum('reason', SUSPICIOUS_REASON).notNull(),
    // 활동한 날(KST). 같은 사용자·사유는 하루 한 번만 표시한다
    date: date('date', { mode: 'string' }).notNull(),
    detail: json('detail').$type<Record<string, unknown>>().notNull(),
    detectedAt: datetime('detected_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
    reviewed: boolean('reviewed').notNull().default(false),
    reviewedBy: binaryUuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: datetime('reviewed_at', { mode: 'date', fsp: 3 }),
  },
  (t) => [
    uniqueIndex('suspicious_flags_daily_uq').on(t.userId, t.date, t.reason),
    index('suspicious_flags_date_idx').on(t.date, t.userId),
  ],
);

export type SuspiciousFlag = typeof suspiciousFlags.$inferSelect;
