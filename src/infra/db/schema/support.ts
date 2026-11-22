import {
  boolean,
  datetime,
  index,
  int,
  mediumtext,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  tinyint,
  varchar,
} from 'drizzle-orm/mysql-core';
import {
  FAQ_CATEGORY,
  INQUIRY_STATUS,
  INQUIRY_TYPE,
  PLATFORM,
} from '../../../common/enums.js';
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

/** 1:1 문의. 답변은 한 개이고 다시 답하면 고쳐 쓴다 */
export const inquiries = mysqlTable(
  'inquiries',
  {
    id: id(),
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: mysqlEnum('type', INQUIRY_TYPE).notNull(),
    title: varchar('title', { length: 50 }).notNull(),
    content: varchar('content', { length: 1000 }).notNull(),
    status: mysqlEnum('status', INQUIRY_STATUS).notNull().default('RECEIVED'),
    platform: mysqlEnum('platform', PLATFORM).notNull(),
    appVersion: varchar('app_version', { length: 32 }).notNull(),
    answerContent: varchar('answer_content', { length: 2000 }),
    answeredBy: binaryUuid('answered_by').references(() => users.id, { onDelete: 'set null' }),
    answeredAt: datetime('answered_at', { mode: 'date', fsp: 3 }),
    ...timestamps,
  },
  (t) => [
    index('inquiries_user_idx').on(t.userId, t.id),
    index('inquiries_status_idx').on(t.status, t.type, t.id),
  ],
);

export type Inquiry = typeof inquiries.$inferSelect;

/** 문의 첨부 이미지. 파일은 UPLOAD_DIR 아래 storage_key 경로에 둔다 */
export const inquiryImages = mysqlTable(
  'inquiry_images',
  {
    id: id(),
    inquiryId: binaryUuid('inquiry_id')
      .notNull()
      .references(() => inquiries.id, { onDelete: 'cascade' }),
    storageKey: varchar('storage_key', { length: 255 }).notNull(),
    mime: varchar('mime', { length: 32 }).notNull(),
    size: int('size').notNull(),
    sortOrder: tinyint('sort_order').notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('inquiry_images_inquiry_idx').on(t.inquiryId, t.sortOrder)],
);
