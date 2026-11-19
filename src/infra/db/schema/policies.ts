import {
  boolean,
  datetime,
  index,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { POLICY_TYPE } from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { users } from './users.js';

export const policies = mysqlTable(
  'policies',
  {
    id: id(),
    type: mysqlEnum('type', POLICY_TYPE).notNull(),
    version: varchar('version', { length: 20 }).notNull(),
    title: varchar('title', { length: 100 }).notNull(),
    content: mediumtext('content').notNull(),
    required: boolean('required').notNull(),
    requireReagreement: boolean('require_reagreement').notNull().default(false),
    effectiveAt: datetime('effective_at', { mode: 'date', fsp: 3 }).notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex('policies_type_version_uq').on(t.type, t.version),
    index('policies_type_effective_idx').on(t.type, t.effectiveAt),
  ],
);

export const userAgreements = mysqlTable(
  'user_agreements',
  {
    id: id(),
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    policyType: mysqlEnum('policy_type', POLICY_TYPE).notNull(),
    version: varchar('version', { length: 20 }).notNull(),
    agreed: boolean('agreed').notNull(),
    agreedAt: datetime('agreed_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (t) => [index('user_agreements_user_type_idx').on(t.userId, t.policyType, t.id)],
);

export type Policy = typeof policies.$inferSelect;
export type UserAgreement = typeof userAgreements.$inferSelect;
