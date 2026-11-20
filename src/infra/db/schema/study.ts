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
  MEMORY_STATUS,
  QUESTION_TYPE,
  QUIZ_DIRECTION,
  QUIZ_MODE,
  STUDY_SESSION_STATUS,
  STUDY_SOURCE,
  WRONG_NOTE_STATUS,
  WRONG_SOURCE,
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
    activeKey: varchar('active_key', { length: 80 }).generatedAlwaysAs(
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

export const studyAnswers = mysqlTable(
  'study_answers',
  {
    sessionId: binaryUuid('session_id')
      .notNull()
      .references(() => studySessions.id, { onDelete: 'cascade' }),
    idx: int('idx').notNull(),
    choiceIndex: tinyint('choice_index'),
    typedAnswer: varchar('typed_answer', { length: 200 }),
    known: boolean('known'),
    correct: boolean('correct'),
    // 너무 빨리 낸 답은 점수·XP·암기 진행에서 뺀다
    counted: boolean('counted').notNull(),
    elapsedMs: int('elapsed_ms').notNull(),
    submittedAt: datetime('submitted_at', { mode: 'date', fsp: 3 })
      .notNull()
      .default(sql`CURRENT_TIMESTAMP(3)`),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.idx] })],
);

export type StudyAnswerRow = typeof studyAnswers.$inferSelect;

/** (단어, 문제 유형) 하나가 오답 항목 하나 */
export const wrongNotes = mysqlTable(
  'wrong_notes',
  {
    id: id(),
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    wordId: binaryUuid('word_id')
      .notNull()
      .references(() => words.id, { onDelete: 'cascade' }),
    packId: binaryUuid('pack_id').notNull(),
    questionType: mysqlEnum('question_type', QUESTION_TYPE).notNull(),
    source: mysqlEnum('source', WRONG_SOURCE).notNull(),
    status: mysqlEnum('status', WRONG_NOTE_STATUS).notNull().default('ACTIVE'),
    wrongCount: int('wrong_count').notNull().default(1),
    consecutiveCorrect: int('consecutive_correct').notNull().default(0),
    lastSessionId: binaryUuid('last_session_id'),
    firstWrongAt: datetime('first_wrong_at', { mode: 'date', fsp: 3 }).notNull(),
    lastWrongAt: datetime('last_wrong_at', { mode: 'date', fsp: 3 }).notNull(),
    graduatedAt: datetime('graduated_at', { mode: 'date', fsp: 3 }),
  },
  (t) => [
    uniqueIndex('wrong_notes_word_type_uq').on(t.userId, t.wordId, t.questionType),
    index('wrong_notes_recent_idx').on(t.userId, t.status, t.lastWrongAt, t.id),
    index('wrong_notes_count_idx').on(t.userId, t.status, t.wrongCount, t.id),
  ],
);

/** 사용자별 단어 암기 진행. 행이 없으면 NEW */
export const userWordProgress = mysqlTable(
  'user_word_progress',
  {
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    wordId: binaryUuid('word_id')
      .notNull()
      .references(() => words.id, { onDelete: 'cascade' }),
    // 단어팩별 집계용 (단어는 팩을 옮기지 않는다)
    packId: binaryUuid('pack_id').notNull(),
    memoryStatus: mysqlEnum('memory_status', MEMORY_STATUS).notNull(),
    correctStreak: int('correct_streak').notNull().default(0),
    lastCorrectSessionId: binaryUuid('last_correct_session_id'),
    totalCorrect: int('total_correct').notNull().default(0),
    totalWrong: int('total_wrong').notNull().default(0),
    lastStudiedAt: datetime('last_studied_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.wordId] }),
    index('user_word_progress_pack_idx').on(t.userId, t.packId, t.memoryStatus),
  ],
);

export type UserWordProgressRow = typeof userWordProgress.$inferSelect;
