import { boolean, mysqlEnum, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { id, softDelete, timestamps } from '../columns.js';

export const users = mysqlTable('users', {
  id: id(),
  datagsmId: varchar('datagsm_id', { length: 64 }).notNull().unique(),
  name: varchar('name', { length: 50 }).notNull(),
  role: mysqlEnum('role', ['STUDENT', 'TEACHER']).notNull(),
  isAdmin: boolean('is_admin').notNull().default(false),
  status: mysqlEnum('status', ['ACTIVE', 'SUSPENDED', 'WITHDRAWN']).notNull().default('ACTIVE'),
  ...timestamps,
  ...softDelete,
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
