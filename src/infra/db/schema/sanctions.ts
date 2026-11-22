import { datetime, index, int, mysqlEnum, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { SANCTION_TYPE } from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { users } from './users.js';

/** 제재 이력. 정지·영구 정지는 users.status에도 반영한다 */
export const sanctions = mysqlTable(
  'sanctions',
  {
    id: id(),
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: mysqlEnum('type', SANCTION_TYPE).notNull(),
    reason: varchar('reason', { length: 200 }).notNull(),
    suspendedUntil: datetime('suspended_until', { mode: 'date', fsp: 3 }),
    revokedXp: int('revoked_xp'),
    reportGroupId: varchar('report_group_id', { length: 100 }),
    adminId: binaryUuid('admin_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('sanctions_user_idx').on(t.userId, t.id)],
);

export type Sanction = typeof sanctions.$inferSelect;
