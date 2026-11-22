import {
  boolean,
  datetime,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  varchar,
} from 'drizzle-orm/mysql-core';
import { BADGE_METRIC, BADGE_TYPE } from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { users } from './users.js';

/** 배지 정의. 업적 배지는 metric 값이 threshold 이상이면 준다 (시즌 배지는 시즌 마감에서 준다) */
export const badges = mysqlTable('badges', {
  id: id(),
  code: varchar('code', { length: 50 }).notNull().unique(),
  type: mysqlEnum('type', BADGE_TYPE).notNull(),
  name: varchar('name', { length: 50 }).notNull(),
  description: varchar('description', { length: 200 }).notNull(),
  conditionText: varchar('condition_text', { length: 100 }).notNull(),
  // 앱이 이미지 주소로 바꾸는 키
  imageUrl: varchar('image_url', { length: 300 }).notNull(),
  metric: mysqlEnum('metric', BADGE_METRIC),
  threshold: int('threshold'),
  sortOrder: int('sort_order').notNull().default(0),
  active: boolean('active').notNull().default(true),
  ...timestamps,
});

export type Badge = typeof badges.$inferSelect;

export const userBadges = mysqlTable(
  'user_badges',
  {
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    badgeId: binaryUuid('badge_id')
      .notNull()
      .references(() => badges.id, { onDelete: 'cascade' }),
    earnedAt: datetime('earned_at', { mode: 'date', fsp: 3 }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.badgeId] }),
    index('user_badges_badge_idx').on(t.badgeId),
  ],
);
