import {
  boolean,
  datetime,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  tinyint,
  varchar,
} from 'drizzle-orm/mysql-core';
import { ACCOUNT_STATUS, ROLE } from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';

export const users = mysqlTable(
  'users',
  {
    id: id(),
    datagsmId: varchar('datagsm_id', { length: 64 }).unique(),
    // 학생 목록 OpenAPI는 계정 ID가 아닌 학생 ID를 준다
    datagsmStudentId: varchar('datagsm_student_id', { length: 64 }).unique(),
    email: varchar('email', { length: 320 }),
    name: varchar('name', { length: 50 }).notNull(),
    role: mysqlEnum('role', ROLE).notNull(),
    isAdmin: boolean('is_admin').notNull().default(false),
    status: mysqlEnum('status', ACCOUNT_STATUS).notNull().default('ACTIVE'),
    studentNumber: varchar('student_number', { length: 10 }),
    grade: tinyint('grade'),
    classNo: tinyint('class_no'),
    number: tinyint('number'),
    avatarId: varchar('avatar_id', { length: 32 }).notNull().default('default'),
    rankingPublic: boolean('ranking_public').notNull().default(true),
    rankingOnboarded: boolean('ranking_onboarded').notNull().default(false),
    totalXp: int('total_xp').notNull().default(0),
    suspendedUntil: datetime('suspended_until', { mode: 'date', fsp: 3 }),
    suspendReason: varchar('suspend_reason', { length: 200 }),
    lastLoginAt: datetime('last_login_at', { mode: 'date', fsp: 3 }),
    withdrawnAt: datetime('withdrawn_at', { mode: 'date', fsp: 3 }),
    ...timestamps,
  },
  (t) => [
    index('users_class_idx').on(t.grade, t.classNo, t.number),
    index('users_status_idx').on(t.status),
    index('users_name_idx').on(t.name),
    // 마지막 관리자 확인에서 관리자 행만 잠그게 한다
    index('users_admin_idx').on(t.isAdmin),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
