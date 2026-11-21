import {
  date,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { XP_BLOCK_REASON, XP_SOURCE } from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { users } from './users.js';

/** 모든 XP 지급의 원장. 랭킹·레벨은 여기서 계산한다 */
export const xpLedger = mysqlTable(
  'xp_ledger',
  {
    id: id(),
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    source: mysqlEnum('source', XP_SOURCE).notNull(),
    // 중복 지급 방지 키 (예: study:{sessionId}, pack:{packId}:{date})
    refKey: varchar('ref_key', { length: 100 }).notNull(),
    amount: int('amount').notNull(),
    blockedReason: mysqlEnum('blocked_reason', XP_BLOCK_REASON),
    date: date('date', { mode: 'string' }).notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex('xp_ledger_ref_uq').on(t.userId, t.source, t.refKey),
    index('xp_ledger_user_date_idx').on(t.userId, t.date),
    index('xp_ledger_user_created_idx').on(t.userId, t.createdAt, t.id),
  ],
);
