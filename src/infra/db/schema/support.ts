import {
  boolean,
  datetime,
  index,
  int,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  varchar,
} from 'drizzle-orm/mysql-core';
import { FAQ_CATEGORY } from '../../../common/enums.js';
import { id, softDelete, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { users } from './users.js';

/** 자주 묻는 질문. 분류 안에서 sort_order 순 */
export const faqs = mysqlTable(
  'faqs',
  {
    id: id(),
    category: mysqlEnum('category', FAQ_CATEGORY).notNull(),
    question: varchar('question', { length: 200 }).notNull(),
    answer: mediumtext('answer').notNull(),
    sortOrder: int('sort_order').notNull().default(0),
    ...timestamps,
  },
  (t) => [index('faqs_category_idx').on(t.category, t.sortOrder)],
);

/** 공지. 지우면 소프트 삭제(사용자에게는 404) */
export const notices = mysqlTable(
  'notices',
  {
    id: id(),
    title: varchar('title', { length: 100 }).notNull(),
    content: mediumtext('content').notNull(),
    pinned: boolean('pinned').notNull().default(false),
    published: boolean('published').notNull().default(true),
    createdBy: binaryUuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
    ...softDelete,
  },
  (t) => [index('notices_list_idx').on(t.published, t.deletedAt, t.pinned, t.id)],
);

export type Notice = typeof notices.$inferSelect;

/** 사용자가 공지를 연 기록 (읽음 표시) */
export const noticeReads = mysqlTable(
  'notice_reads',
  {
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    noticeId: binaryUuid('notice_id')
      .notNull()
      .references(() => notices.id, { onDelete: 'cascade' }),
    readAt: datetime('read_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.noticeId] })],
);
