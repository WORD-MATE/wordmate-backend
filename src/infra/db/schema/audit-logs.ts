import { index, json, mysqlTable, varchar } from 'drizzle-orm/mysql-core';
import type { AuditAction } from '../../../common/enums.js';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { users } from './users.js';

export const auditLogs = mysqlTable(
  'audit_logs',
  {
    id: id(),
    actorId: binaryUuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 50 }).$type<AuditAction>().notNull(),
    targetType: varchar('target_type', { length: 30 }).notNull(),
    targetId: varchar('target_id', { length: 64 }),
    detail: json('detail').$type<Record<string, unknown>>().notNull(),
    ip: varchar('ip', { length: 45 }),
    userAgent: varchar('user_agent', { length: 255 }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    index('audit_logs_actor_idx').on(t.actorId, t.id),
    index('audit_logs_target_idx').on(t.targetId, t.id),
    index('audit_logs_action_idx').on(t.action, t.id),
    index('audit_logs_created_idx').on(t.createdAt),
  ],
);
