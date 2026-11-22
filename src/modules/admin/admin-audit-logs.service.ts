import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, gte, lt, type SQL } from 'drizzle-orm';
import type { Page } from '../../common/pagination.js';
import { kstDayRange } from '../../common/time/kst.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { auditLogs, users } from '../../infra/db/schema/index.js';
import { toUserSummary } from '../users/user-summary.js';
import type { AuditLogItem, AuditLogQuery } from './admin-audit-logs.schemas.js';

@Injectable()
export class AdminAuditLogsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** 최신순 */
  async list(query: AuditLogQuery): Promise<Page<AuditLogItem>> {
    const conditions: (SQL | undefined)[] = [
      query.actorId ? eq(auditLogs.actorId, query.actorId) : undefined,
      query.targetId ? eq(auditLogs.targetId, query.targetId) : undefined,
      query.action ? eq(auditLogs.action, query.action) : undefined,
      query.from ? gte(auditLogs.createdAt, kstDayRange(query.from).start) : undefined,
      query.to ? lt(auditLogs.createdAt, kstDayRange(query.to).end) : undefined,
    ];
    const where = and(...conditions);
    const [total] = await this.db.select({ value: count() }).from(auditLogs).where(where);
    const rows = await this.db
      .select({ log: auditLogs, actor: users })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorId))
      .where(where)
      .orderBy(desc(auditLogs.id))
      .limit(query.size)
      .offset(query.page * query.size);
    return {
      totalCount: total?.value ?? 0,
      items: rows.map(({ log, actor }) => ({
        logId: log.id,
        actor: actor ? toUserSummary(actor) : null,
        action: log.action,
        targetType: log.targetType,
        targetId: log.targetId,
        detail: log.detail,
        ip: log.ip,
        createdAt: log.createdAt.toISOString(),
      })),
    };
  }
}
