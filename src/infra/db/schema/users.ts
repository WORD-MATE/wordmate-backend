import { boolean, mysqlEnum, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { ACCOUNT_STATUS, ROLE } from '../../../common/enums.js';
import { id, softDelete, timestamps } from '../columns.js';

export const users = mysqlTable('users', {
  id: id(),
  datagsmId: varchar('datagsm_id', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 50 }).notNull(),
  role: mysqlEnum('role', ROLE).notNull(),
  isAdmin: boolean('is_admin').notNull().default(false),
  status: mysqlEnum('status', ACCOUNT_STATUS).notNull().default('ACTIVE'),
  ...timestamps,
  ...softDelete,
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
