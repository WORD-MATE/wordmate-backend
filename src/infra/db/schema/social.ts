import { datetime, index, mysqlTable, primaryKey, uniqueIndex } from 'drizzle-orm/mysql-core';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { users } from './users.js';

/** 대기 중인 친구 요청. 수락·거절·취소하면 지운다 */
export const friendRequests = mysqlTable(
  'friend_requests',
  {
    id: id(),
    requesterId: binaryUuid('requester_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    receiverId: binaryUuid('receiver_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    uniqueIndex('friend_requests_pair_uq').on(t.requesterId, t.receiverId),
    index('friend_requests_receiver_idx').on(t.receiverId, t.createdAt),
  ],
);

/** 친구 관계. 양쪽 방향으로 한 줄씩 넣어 한쪽 기준으로 바로 찾는다 */
export const friendships = mysqlTable(
  'friendships',
  {
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    friendId: binaryUuid('friend_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    since: datetime('since', { mode: 'date', fsp: 3 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.friendId] })],
);

/** 차단. 차단한 사람 기준 한 줄이고 상대에게 알리지 않는다 */
export const blocks = mysqlTable(
  'blocks',
  {
    blockerId: binaryUuid('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: binaryUuid('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.blockerId, t.blockedId] }),
    index('blocks_blocked_idx').on(t.blockedId),
  ],
);
