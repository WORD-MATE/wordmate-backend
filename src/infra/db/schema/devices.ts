import { char, datetime, index, mysqlEnum, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import { PLATFORM, PUSH_TYPE } from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { users } from './users.js';

export const devices = mysqlTable(
  'devices',
  {
    id: id(),
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: mysqlEnum('platform', PLATFORM).notNull(),
    name: varchar('name', { length: 100 }),
    pushType: mysqlEnum('push_type', PUSH_TYPE),
    pushToken: varchar('push_token', { length: 512 }).unique(),
    webPushEndpoint: varchar('webpush_endpoint', { length: 700 }).unique(),
    webPushP256dh: varchar('webpush_p256dh', { length: 255 }),
    webPushAuth: varchar('webpush_auth', { length: 64 }),
    lastUsedAt: datetime('last_used_at', { mode: 'date', fsp: 3 }).notNull(),
    revokedAt: datetime('revoked_at', { mode: 'date', fsp: 3 }),
    ...timestamps,
  },
  (t) => [index('devices_user_revoked_idx').on(t.userId, t.revokedAt)],
);

export const refreshTokens = mysqlTable(
  'refresh_tokens',
  {
    id: id(),
    deviceId: binaryUuid('device_id')
      .notNull()
      .references(() => devices.id, { onDelete: 'cascade' }),
    tokenHash: char('token_hash', { length: 64 }).notNull().unique(),
    expiresAt: datetime('expires_at', { mode: 'date', fsp: 3 }).notNull(),
    usedAt: datetime('used_at', { mode: 'date', fsp: 3 }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('refresh_tokens_device_idx').on(t.deviceId),
    index('refresh_tokens_expires_idx').on(t.expiresAt),
  ],
);

export type Device = typeof devices.$inferSelect;
export type RefreshToken = typeof refreshTokens.$inferSelect;
