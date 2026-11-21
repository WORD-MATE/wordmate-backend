import { sql } from 'drizzle-orm';
import {
  boolean,
  char,
  datetime,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { PARTICIPANT_STATE, QUESTION_TYPE, ROOM_STATUS, ROOM_TYPE } from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { classes } from './classes.js';
import { packs } from './packs.js';
import { users } from './users.js';

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
