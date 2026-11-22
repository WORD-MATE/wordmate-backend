import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, inArray, lte, min, or, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { AuditLogService } from '../../common/audit/audit-log.service.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { SUSPICIOUS_REASON } from '../../common/enums.js';
import { AppException } from '../../common/errors/app-exception.js';
import type { Page } from '../../common/pagination.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { suspiciousFlags, users } from '../../infra/db/schema/index.js';
import { toUserSummary } from '../users/user-summary.js';
import type {
  AdminSuspiciousItem,
  AdminSuspiciousQuery,
  ReviewSuspicious,
} from './admin-suspicious.schemas.js';

export const AdminSuspiciousErrors = {
  notFound: () =>
    new AppException(
      'SUSPICIOUS_NOT_FOUND',
      '부정 의심 표시를 찾을 수 없습니다.',
      HttpStatus.NOT_FOUND,
    ),
};

const flags = suspiciousFlags;

@Injectable()
export class AdminSuspiciousService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditLogService,
  ) {}

  /** 사용자·날짜별로 묶어 최근 날짜부터 */
  async list(query: AdminSuspiciousQuery): Promise<Page<AdminSuspiciousItem>> {
    const where = and(
      query.from ? gte(flags.date, query.from) : undefined,
      query.to ? lte(flags.date, query.to) : undefined,
    );
    const having = and(
      query.reason ? sql`SUM(${flags.reason} = ${query.reason}) > 0` : undefined,
      query.reviewed === undefined
        ? undefined
        : sql`MIN(${flags.reviewed}) = ${query.reviewed ? 1 : 0}`,
    );
    const grouped = () =>
      this.db
        .select({ userId: flags.userId, date: flags.date, detectedAt: min(flags.detectedAt) })
        .from(flags)
        .where(where)
        .groupBy(flags.userId, flags.date)
        .having(having);
    const [total] = await this.db.select({ value: count() }).from(grouped().as('g'));
    const groups = await grouped()
      .orderBy(desc(flags.date), desc(min(flags.detectedAt)), asc(flags.userId))
      .limit(query.size)
      .offset(query.page * query.size);
    if (groups.length === 0) return { totalCount: total?.value ?? 0, items: [] };

    const userIds = [...new Set(groups.map((g) => g.userId))];
    const [rows, people] = await Promise.all([
      this.db
        .select()
        .from(flags)
        .where(or(...groups.map((g) => and(eq(flags.userId, g.userId), eq(flags.date, g.date))))),
      this.db.select().from(users).where(inArray(users.id, userIds)),
    ]);
    const userById = new Map(people.map((u) => [u.id, u]));
    const items = groups.flatMap((group) => {
      const user = userById.get(group.userId);
      const mine = rows
        .filter((r) => r.userId === group.userId && r.date === group.date)
        .sort((a, b) => SUSPICIOUS_REASON.indexOf(a.reason) - SUSPICIOUS_REASON.indexOf(b.reason));
      if (!user || !group.detectedAt) return [];
      return [
        {
          user: toUserSummary(user),
          date: group.date,
          reasons: mine.map((r) => r.reason),
          detail: Object.fromEntries(mine.map((r) => [r.reason, r.detail])),
          detectedAt: group.detectedAt.toISOString(),
          reviewed: mine.every((r) => r.reviewed),
        },
      ];
    });
    return { totalCount: total?.value ?? 0, items };
  }

  /** 그날 그 사용자의 표시를 모두 확인함(또는 확인 취소)으로 바꾼다. 제재는 따로 한다 */
  async review(
    admin: AuthUser,
    userId: string,
    date: string,
    body: ReviewSuspicious,
    request: FastifyRequest,
  ): Promise<void> {
    const target = and(eq(flags.userId, userId), eq(flags.date, date));
    await this.db.transaction(async (tx) => {
      const locked = await tx
        .select({ id: flags.id, reason: flags.reason })
        .from(flags)
        .where(target)
        .for('update');
      if (locked.length === 0) throw AdminSuspiciousErrors.notFound();
      await tx
        .update(flags)
        .set(
          body.reviewed
            ? { reviewed: true, reviewedBy: admin.userId, reviewedAt: new Date() }
            : { reviewed: false, reviewedBy: null, reviewedAt: null },
        )
        .where(target);
      await this.audit.record(
        {
          actorId: admin.userId,
          action: 'SUSPICIOUS_REVIEW',
          targetType: 'USER',
          targetId: userId,
          detail: { date, reviewed: body.reviewed, reasons: locked.map((f) => f.reason) },
        },
        request,
        tx,
      );
    });
  }
}
