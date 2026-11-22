import { index, int, mediumtext, mysqlEnum, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { FAQ_CATEGORY } from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';

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
