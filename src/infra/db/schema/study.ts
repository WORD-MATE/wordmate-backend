import { sql } from 'drizzle-orm';
import {
  boolean,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  tinyint,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import {
  QUESTION_TYPE,
  QUIZ_DIRECTION,
  QUIZ_MODE,
  STUDY_SESSION_STATUS,
  STUDY_SOURCE,
} from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { packs } from './packs.js';
import { users } from './users.js';
import { words } from './words.js';

export const studySessions = mysqlTable(
  'study_sessions',
  {
    id: id(),
    // user_id·pack_id는 active_key의 기반 컬럼이라 CASCADE 불가 (사용자는 익명화, 팩은 소프트 삭제)
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id),
    source: mysqlEnum('source', STUDY_SOURCE).notNull(),
    packId: binaryUuid('pack_id').references(() => packs.id),
    mode: mysqlEnum('mode', QUIZ_MODE).notNull(),
    direction: mysqlEnum('direction', QUIZ_DIRECTION).notNull(),
    shuffle: boolean('shuffle').notNull(),
    status: mysqlEnum('status', STUDY_SESSION_STATUS).notNull().default('IN_PROGRESS'),
    total: int('total').notNull(),
    answeredCount: int('answered_count').notNull().default(0),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    completedAt: datetime('completed_at', { mode: 'date', fsp: 3 }),
    // 이어할 학습은 팩마다(팩이 없는 소스는 소스마다) 하나만
    activeKey: varchar('active_key', { length: 64 }).generatedAlwaysAs(
      sql`IF(status = 'IN_PROGRESS', CONCAT(HEX(user_id), ':', IFNULL(HEX(pack_id), source)), NULL)`,
      { mode: 'stored' },
    ),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('study_sessions_active_uq').on(t.activeKey),
    index('study_sessions_user_status_idx').on(t.userId, t.status, t.updatedAt),
    index('study_sessions_expiry_idx').on(t.status, t.expiresAt),
  ],
);

export type StudySessionRow = typeof studySessions.$inferSelect;

export type QuestionCard = { english: string; meanings: string[] };

/** 문항·보기는 만들 때 고정해 저장한다 (이어하기·채점 때 그대로 쓴다) */
export const studySessionQuestions = mysqlTable(
  'study_session_questions',
  {
    sessionId: binaryUuid('session_id')
      .notNull()
      .references(() => studySessions.id, { onDelete: 'cascade' }),
    idx: int('idx').notNull(),
    wordId: binaryUuid('word_id')
      .notNull()
      .references(() => words.id),
    questionType: mysqlEnum('question_type', QUESTION_TYPE),
    prompt: varchar('prompt', { length: 600 }).notNull(),
    derivatives: json('derivatives').$type<string[]>().notNull(),
    choices: json('choices').$type<string[]>(),
    answerIndex: tinyint('answer_index'),
    // TYPING 채점용. 클라이언트에 내려주지 않는다
    acceptedAnswers: json('accepted_answers').$type<string[]>(),
    card: json('card').$type<QuestionCard>(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.idx] })],
);

export type StudyQuestionRow = typeof studySessionQuestions.$inferSelect;
