import {
  date,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  varchar,
} from 'drizzle-orm/mysql-core';
import { MORNING_QUIZ_TYPE, MORNING_STATUS } from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { users } from './users.js';

/** 오늘의 문장. 날짜마다 하나 */
export const morningSentences = mysqlTable(
  'morning_sentences',
  {
    id: id(),
    publishDate: date('publish_date', { mode: 'string' }).notNull().unique(),
    status: mysqlEnum('status', MORNING_STATUS).notNull().default('PENDING_REVIEW'),
    sentence: varchar('sentence', { length: 500 }).notNull(),
    translation: varchar('translation', { length: 500 }).notNull(),
    // 마지막으로 고친 관리자 (시드는 NULL)
    updatedBy: binaryUuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('morning_sentences_status_idx').on(t.status, t.publishDate)],
);

export type MorningSentenceRow = typeof morningSentences.$inferSelect;

/** 핵심 어휘. highlight는 문장 안 위치(UTF-16 코드 단위, end 미포함) */
export const morningKeywords = mysqlTable(
  'morning_keywords',
  {
    sentenceId: binaryUuid('sentence_id')
      .notNull()
      .references(() => morningSentences.id, { onDelete: 'cascade' }),
    idx: int('idx').notNull(),
    english: varchar('english', { length: 50 }).notNull(),
    meanings: json('meanings').$type<string[]>().notNull(),
    example: varchar('example', { length: 500 }),
    highlightStart: int('highlight_start').notNull(),
    highlightEnd: int('highlight_end').notNull(),
  },
  (t) => [primaryKey({ columns: [t.sentenceId, t.idx] })],
);

export const morningQuizzes = mysqlTable(
  'morning_quizzes',
  {
    sentenceId: binaryUuid('sentence_id')
      .notNull()
      .references(() => morningSentences.id, { onDelete: 'cascade' }),
    idx: int('idx').notNull(),
    type: mysqlEnum('type', MORNING_QUIZ_TYPE).notNull(),
    question: varchar('question', { length: 500 }).notNull(),
    choices: json('choices').$type<string[]>(),
    answers: json('answers').$type<string[]>().notNull(),
    explanation: varchar('explanation', { length: 500 }),
  },
  (t) => [primaryKey({ columns: [t.sentenceId, t.idx] })],
);

/** 문장 퀴즈 처음 완료한 기록 */
export const morningCompletions = mysqlTable(
  'morning_completions',
  {
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sentenceId: binaryUuid('sentence_id')
      .notNull()
      .references(() => morningSentences.id, { onDelete: 'cascade' }),
    correctCount: int('correct_count').notNull(),
    total: int('total').notNull(),
    xpGranted: int('xp_granted').notNull(),
    completedAt: datetime('completed_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.sentenceId] }),
    index('morning_completions_user_idx').on(t.userId, t.completedAt),
  ],
);
