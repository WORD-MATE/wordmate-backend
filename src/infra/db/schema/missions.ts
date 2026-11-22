import {
  boolean,
  date,
  datetime,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  varchar,
} from 'drizzle-orm/mysql-core';
import { MISSION_METRIC, MISSION_PERIOD } from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { users } from './users.js';

/** 미션 정의. 데이터로 등록하고, 끈 미션은 목록에서 빠진다 */
export const missions = mysqlTable(
  'missions',
  {
    id: id(),
    code: varchar('code', { length: 50 }).notNull().unique(),
    period: mysqlEnum('period', MISSION_PERIOD).notNull(),
    metric: mysqlEnum('metric', MISSION_METRIC).notNull(),
    title: varchar('title', { length: 100 }).notNull(),
    target: int('target').notNull(),
    rewardXp: int('reward_xp').notNull(),
    sortOrder: int('sort_order').notNull().default(0),
    active: boolean('active').notNull().default(true),
    ...timestamps,
  },
  (t) => [index('missions_metric_idx').on(t.metric, t.active)],
);

export type Mission = typeof missions.$inferSelect;

/** 사용자별 진행. 기간(일일은 그날, 주간은 그 주 월요일, KST)마다 한 줄이라 기간이 바뀌면 새로 센다 */
export const userMissions = mysqlTable(
  'user_missions',
  {
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    missionId: binaryUuid('mission_id')
      .notNull()
      .references(() => missions.id, { onDelete: 'cascade' }),
    periodKey: date('period_key', { mode: 'string' }).notNull(),
    progress: int('progress').notNull().default(0),
    claimedAt: datetime('claimed_at', { mode: 'date', fsp: 3 }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.missionId, t.periodKey] }),
    index('user_missions_period_idx').on(t.periodKey),
  ],
);
