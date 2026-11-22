import {
  boolean,
  char,
  datetime,
  index,
  json,
  mysqlEnum,
  mysqlTable,
  varchar,
} from 'drizzle-orm/mysql-core';
import { NOTIFICATION_TYPE, type Weekday } from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { users } from './users.js';

/** 받은 알림. 30일 동안 보관한다 (UUIDv7이라 id 순서가 곧 시간 순서) */
export const notifications = mysqlTable(
  'notifications',
  {
    id: id(),
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: mysqlEnum('type', NOTIFICATION_TYPE).notNull(),
    title: varchar('title', { length: 100 }).notNull(),
    body: varchar('body', { length: 500 }).notNull(),
    // 눌렀을 때 이동할 앱 경로 (예: /friends/requests)
    route: varchar('route', { length: 200 }),
    readAt: datetime('read_at', { mode: 'date', fsp: 3 }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('notifications_user_id_idx').on(t.userId, t.id),
    index('notifications_user_read_idx').on(t.userId, t.readAt),
    index('notifications_created_idx').on(t.createdAt),
  ],
);

/** 계정 단위 알림 설정 (모든 기기에 같이 적용). 행이 없으면 기본값 */
export const notificationSettings = mysqlTable('notification_settings', {
  userId: binaryUuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  studyReminder: boolean('study_reminder').notNull(),
  morningSentence: boolean('morning_sentence').notNull(),
  battle: boolean('battle').notNull(),
  ranking: boolean('ranking').notNull(),
  notice: boolean('notice').notNull(),
  marketing: boolean('marketing').notNull(),
  // KST HH:mm, NULL이면 학습 리마인더를 보내지 않는다
  reminderTime: char('reminder_time', { length: 5 }),
  reminderWeekdays: json('reminder_weekdays').$type<Weekday[]>().notNull(),
  ...timestamps,
});
