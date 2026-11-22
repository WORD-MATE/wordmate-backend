import {
  boolean,
  date,
  datetime,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { SEASON_PERIOD, SEASON_STATUS } from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { users } from './users.js';

/** 주간·월간 기간 하나가 시즌 하나. 마감하면 그 기간의 순위를 스냅샷으로 남긴다 */
export const rankingSeasons = mysqlTable(
  'ranking_seasons',
  {
    id: id(),
    period: mysqlEnum('period', SEASON_PERIOD).notNull(),
    // 주간은 그 주 월요일, 월간은 YYYY-MM (랭킹 키와 같음)
    periodKey: varchar('period_key', { length: 10 }).notNull(),
    startsOn: date('starts_on', { mode: 'string' }).notNull(),
    // 다음 기간 첫날 (이 날은 포함하지 않는다)
    endsOn: date('ends_on', { mode: 'string' }).notNull(),
    status: mysqlEnum('status', SEASON_STATUS).notNull().default('CLOSED_PENDING'),
    attempts: int('attempts').notNull().default(0),
    lastError: varchar('last_error', { length: 500 }),
    confirmedAt: datetime('confirmed_at', { mode: 'date', fsp: 3 }),
    ...timestamps,
  },
  (t) => [uniqueIndex('ranking_seasons_period_uq').on(t.period, t.periodKey)],
);

export type RankingSeason = typeof rankingSeasons.$inferSelect;

export const rankingSnapshots = mysqlTable(
  'ranking_snapshots',
  {
    seasonId: binaryUuid('season_id')
      .notNull()
      .references(() => rankingSeasons.id, { onDelete: 'cascade' }),
    // school, grade:N, class:N-M
    scope: varchar('scope', { length: 32 }).notNull(),
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // 공개 사용자 사이의 순위. 목록에 없던 사용자(비공개 등)도 자기를 끼워 넣은 순위를 남긴다.
    // 관리자가 시즌에서 제외한 사용자는 null
    rank: int('rank'),
    // 마감 시점 순서 (0부터). XP 동점의 도달 순서는 여기에만 남아서, 제외를 바꿔 순위를 다시 매길 때 쓴다
    position: int('position').notNull(),
    xp: int('xp').notNull(),
    // 마감 시점에 랭킹 목록에 보였는지
    listed: boolean('listed').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.seasonId, t.scope, t.userId] }),
    index('ranking_snapshots_user_idx').on(t.userId, t.seasonId),
  ],
);

/** 관리자가 시즌 순위에서 뺀 사용자. 마감을 다시 돌려도 다시 적용한다 */
export const rankingSeasonExclusions = mysqlTable(
  'ranking_season_exclusions',
  {
    seasonId: binaryUuid('season_id')
      .notNull()
      .references(() => rankingSeasons.id, { onDelete: 'cascade' }),
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    reason: varchar('reason', { length: 200 }).notNull(),
    adminId: binaryUuid('admin_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.seasonId, t.userId] })],
);
