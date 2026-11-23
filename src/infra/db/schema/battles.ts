import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  date,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import {
  BATTLE_OUTCOME,
  BATTLE_PHASE,
  PARTICIPANT_STATE,
  QUESTION_TYPE,
  ROOM_STATUS,
  ROOM_TYPE,
  XP_BLOCK_REASON,
} from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { classes } from './classes.js';
import { packs } from './packs.js';
import { users } from './users.js';
import { words } from './words.js';

export const battleRooms = mysqlTable(
  'battle_rooms',
  {
    id: id(),
    inviteCode: char('invite_code', { length: 6 }).notNull(),
    type: mysqlEnum('type', ROOM_TYPE).notNull(),
    status: mysqlEnum('status', ROOM_STATUS).notNull().default('WAITING'),
    hostUserId: binaryUuid('host_user_id').references(() => users.id),
    classId: binaryUuid('class_id').references(() => classes.id),
    packId: binaryUuid('pack_id')
      .notNull()
      .references(() => packs.id),
    // 팩 이름이 바뀌거나 팩이 지워져도 방·결과 화면에는 만들 때 이름을 보여준다
    packName: varchar('pack_name', { length: 30 }).notNull(),
    questionType: mysqlEnum('question_type', QUESTION_TYPE).notNull(),
    questionCount: int('question_count').notNull(),
    timeLimitSec: int('time_limit_sec').notNull(),
    maxParticipants: int('max_participants').notNull(),
    duplicateQuestions: boolean('duplicate_questions').notNull(),
    sourceBattleId: binaryUuid('source_battle_id'),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    // 카운트다운이 끝나는 시각. 시작 작업이 자기 카운트다운인지 확인하는 데 쓴다 (취소 뒤 다시 시작한 경우)
    countdownEndsAt: datetime('countdown_ends_at', { mode: 'date', fsp: 3 }),
    startedAt: datetime('started_at', { mode: 'date', fsp: 3 }),
    finishedAt: datetime('finished_at', { mode: 'date', fsp: 3 }),
    // 초대 코드는 진행 중인 방끼리만 겹치지 않으면 된다 (끝난 방의 코드는 다시 쓸 수 있다)
    activeCode: char('active_code', { length: 6 }).generatedAlwaysAs(
      sql`IF(status IN ('WAITING', 'COUNTDOWN', 'IN_PROGRESS'), invite_code, NULL)`,
      { mode: 'stored' },
    ),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('battle_rooms_active_code_uq').on(t.activeCode),
    index('battle_rooms_code_idx').on(t.inviteCode, t.createdAt),
    index('battle_rooms_expiry_idx').on(t.status, t.expiresAt),
  ],
);

export type BattleRoom = typeof battleRooms.$inferSelect;

export const battleRoomParticipants = mysqlTable(
  'battle_room_participants',
  {
    roomId: binaryUuid('room_id')
      .notNull()
      .references(() => battleRooms.id, { onDelete: 'cascade' }),
    // active_user의 기반 컬럼이라 CASCADE 불가 (사용자는 삭제하지 않고 익명화)
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id),
    state: mysqlEnum('state', PARTICIPANT_STATE).notNull().default('CONNECTED'),
    isHost: boolean('is_host').notNull().default(false),
    // 이 방에 아직 있는지 (나가기·강퇴·방 종료·만료면 false)
    active: boolean('active').notNull().default(true),
    joinedAt: datetime('joined_at', { mode: 'date', fsp: 3 }).notNull(),
    // 진행 중 끊긴 시각. 30초 유예 작업이 그사이 돌아왔다 다시 끊긴 경우를 구분하는 데 쓴다
    disconnectedAt: datetime('disconnected_at', { mode: 'date', fsp: 3 }),
    leftAt: datetime('left_at', { mode: 'date', fsp: 3 }),
    // 사용자당 활성 방 하나 (생성·참가·매칭·다시 하기 모두 이 제약으로 막는다)
    activeUser: binaryUuid('active_user').generatedAlwaysAs(sql`IF(active, user_id, NULL)`, {
      mode: 'stored',
    }),
  },
  (t) => [
    primaryKey({ columns: [t.roomId, t.userId] }),
    uniqueIndex('battle_room_participants_active_user_uq').on(t.activeUser),
  ],
);

/** 대결 한 판. 문항 진행 상태를 여기 두고, 문항 시작·종료는 이 행을 잠가 한 번만 일어나게 한다 */
export const battles = mysqlTable(
  'battles',
  {
    id: id(),
    roomId: binaryUuid('room_id')
      .notNull()
      .references(() => battleRooms.id, { onDelete: 'cascade' }),
    questionCount: int('question_count').notNull(),
    timeLimitSec: int('time_limit_sec').notNull(),
    phase: mysqlEnum('phase', BATTLE_PHASE).notNull().default('READY'),
    // 마지막으로 시작한 문항 (아직 없으면 -1)
    currentIndex: int('current_index').notNull().default(-1),
    questionStartedAt: datetime('question_started_at', { mode: 'date', fsp: 3 }),
    deadlineAt: datetime('deadline_at', { mode: 'date', fsp: 3 }),
    startedAt: datetime('started_at', { mode: 'date', fsp: 3 }).notNull(),
    finishedAt: datetime('finished_at', { mode: 'date', fsp: 3 }),
    ...timestamps,
  },
  (t) => [uniqueIndex('battles_room_uq').on(t.roomId)],
);

export type Battle = typeof battles.$inferSelect;

/** 시작할 때 서버가 만들어 고정한 문항과 보기 */
export const battleQuestions = mysqlTable(
  'battle_questions',
  {
    battleId: binaryUuid('battle_id')
      .notNull()
      .references(() => battles.id, { onDelete: 'cascade' }),
    idx: int('idx').notNull(),
    wordId: binaryUuid('word_id')
      .notNull()
      .references(() => words.id),
    questionType: mysqlEnum('question_type', QUESTION_TYPE).notNull(),
    prompt: varchar('prompt', { length: 1000 }).notNull(),
    choices: json('choices').$type<string[]>().notNull(),
    answerIndex: int('answer_index').notNull(),
  },
  (t) => [primaryKey({ columns: [t.battleId, t.idx] })],
);

/** 문항별 답. 마감까지 답하지 않은 참가자는 문항이 끝날 때 choice_index NULL로 남긴다 */
export const battleAnswers = mysqlTable(
  'battle_answers',
  {
    battleId: binaryUuid('battle_id')
      .notNull()
      .references(() => battles.id, { onDelete: 'cascade' }),
    idx: int('idx').notNull(),
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id),
    choiceIndex: int('choice_index'),
    // 서버가 받은 시각 (판정 기준)
    receivedAt: datetime('received_at', { mode: 'date', fsp: 3 }),
    elapsedMs: int('elapsed_ms'),
    correct: boolean('correct').notNull(),
    score: int('score').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.battleId, t.idx, t.userId] }),
    index('battle_answers_user_idx').on(t.userId),
  ],
);

/** 대결이 끝날 때 확정한 참가자별 결과. 기록·결과 화면이 여기서 읽는다 */
export const battleResults = mysqlTable(
  'battle_results',
  {
    battleId: binaryUuid('battle_id')
      .notNull()
      .references(() => battles.id, { onDelete: 'cascade' }),
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id),
    // 중도 이탈은 NULL
    rank: int('rank'),
    score: int('score').notNull(),
    correctCount: int('correct_count').notNull(),
    totalTimeMs: int('total_time_ms').notNull(),
    outcome: mysqlEnum('outcome', BATTLE_OUTCOME).notNull(),
    xpEarned: int('xp_earned').notNull(),
    xpBlockedReason: mysqlEnum('xp_blocked_reason', XP_BLOCK_REASON),
    // 기록 목록 정렬·커서용으로 대결 종료 시각을 함께 둔다
    finishedAt: datetime('finished_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.battleId, t.userId] }),
    index('battle_results_history_idx').on(t.userId, t.finishedAt, t.battleId),
  ],
);

/** 같은 상대와 하루(KST)에 완주한 대결 수. 하루 3번까지만 XP를 준다 */
export const battleDailyPairs = mysqlTable(
  'battle_daily_pairs',
  {
    date: date('date', { mode: 'string' }).notNull(),
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id),
    opponentId: binaryUuid('opponent_id')
      .notNull()
      .references(() => users.id),
    count: int('count').notNull(),
  },
  (t) => [primaryKey({ columns: [t.date, t.userId, t.opponentId] })],
);

/** 혼자 하는 연습. 정답을 미리 내려주고 클라이언트가 시간을 잰다 (XP 없음) */
export const practiceSessions = mysqlTable(
  'practice_sessions',
  {
    id: id(),
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id),
    packId: binaryUuid('pack_id').notNull(),
    questionType: mysqlEnum('question_type', QUESTION_TYPE).notNull(),
    questionCount: int('question_count').notNull(),
    timeLimitSec: int('time_limit_sec').notNull(),
    questions: json('questions')
      .$type<
        { index: number; wordId: string; prompt: string; choices: string[]; answerIndex: number }[]
      >()
      .notNull(),
    score: int('score'),
    correctCount: int('correct_count'),
    completedAt: datetime('completed_at', { mode: 'date', fsp: 3 }),
    ...timestamps,
  },
  (t) => [index('practice_sessions_created_idx').on(t.createdAt)],
);

export type ChallengeQuestion = {
  index: number;
  wordId: string;
  packId: string;
  prompt: string;
  choices: string[];
  answerIndex: number;
};

/** 오늘의 챌린지 문제 세트. 날짜(KST)마다 하나, 모두 같은 문제·같은 순서 */
export const dailyChallenges = mysqlTable('daily_challenges', {
  date: date('date', { mode: 'string' }).primaryKey(),
  questionType: mysqlEnum('question_type', QUESTION_TYPE).notNull(),
  questionCount: int('question_count').notNull(),
  timeLimitSec: int('time_limit_sec').notNull(),
  questions: json('questions').$type<ChallengeQuestion[]>().notNull(),
  createdAt: timestamps.createdAt,
});

export type DailyChallenge = typeof dailyChallenges.$inferSelect;

/** 사용자당 하루 한 번 */
export const challengeAttempts = mysqlTable(
  'challenge_attempts',
  {
    id: id(),
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id),
    date: date('date', { mode: 'string' })
      .notNull()
      .references(() => dailyChallenges.date),
    startedAt: datetime('started_at', { mode: 'date', fsp: 3 }).notNull(),
    completedAt: datetime('completed_at', { mode: 'date', fsp: 3 }),
    score: int('score'),
    correctCount: int('correct_count'),
    answers:
      json('answers').$type<{ index: number; choiceIndex: number | null; elapsedMs: number }[]>(),
    xpEarned: int('xp_earned'),
    xpBlockedReason: mysqlEnum('xp_blocked_reason', XP_BLOCK_REASON),
  },
  (t) => [uniqueIndex('challenge_attempts_user_date_uq').on(t.userId, t.date)],
);
