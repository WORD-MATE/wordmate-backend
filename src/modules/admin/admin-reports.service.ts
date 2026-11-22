import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, count, desc, eq, exists, gte, inArray, lt, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { AuditLogService } from '../../common/audit/audit-log.service.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import type { ReportReason, ReportResult } from '../../common/enums.js';
import { AppException } from '../../common/errors/app-exception.js';
import type { Page } from '../../common/pagination.js';
import { kstDayRange } from '../../common/time/kst.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import {
  packs,
  type ReportGroup,
  reportGroupHistory,
  reportGroups,
  reports,
  users,
  words,
} from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { toUserSummary } from '../users/user-summary.js';
import type {
  AdminReportGroup,
  AdminReportGroupDetail,
  AdminReportQuery,
  UpdateReportGroup,
} from './admin-reports.schemas.js';
import { AdminSanctionsService } from './admin-sanctions.service.js';

export const AdminReportErrors = {
  notFound: () =>
    new AppException('REPORT_NOT_FOUND', '신고를 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
  alreadyResolved: () =>
    new AppException(
      'REPORT_ALREADY_RESOLVED',
      '처리가 끝난 신고는 결과와 메모만 고칠 수 있습니다.',
      HttpStatus.CONFLICT,
    ),
};

const RESULT_MESSAGES: Record<ReportResult, string> = {
  DISMISSED: '신고하신 내용을 검토했지만 문제를 확인하지 못했어요.',
  WARNING: '신고하신 내용을 검토해 조치했어요.',
  SANCTIONED: '신고하신 내용을 검토해 조치했어요.',
};

@Injectable()
export class AdminReportsService {
  private readonly logger = new Logger(AdminReportsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditLogService,
    private readonly notifications: NotificationsService,
    private readonly sanctions: AdminSanctionsService,
  ) {}

  /** 최근에 신고가 들어온 묶음부터 */
  async list(query: AdminReportQuery): Promise<Page<AdminReportGroup>> {
    const conditions: (SQL | undefined)[] = [
      query.status ? eq(reportGroups.status, query.status) : undefined,
      query.reason
        ? exists(
            this.db
              .select({ id: reports.id })
              .from(reports)
              .where(and(eq(reports.groupId, reportGroups.id), eq(reports.reason, query.reason))),
          )
        : undefined,
      query.from ? gte(reportGroups.lastReportedAt, kstDayRange(query.from).start) : undefined,
      query.to ? lt(reportGroups.lastReportedAt, kstDayRange(query.to).end) : undefined,
    ];
    const where = and(...conditions);
    const [total] = await this.db.select({ value: count() }).from(reportGroups).where(where);
    const groups = await this.db
      .select()
      .from(reportGroups)
      .where(where)
      .orderBy(desc(reportGroups.lastReportedAt), desc(reportGroups.id))
      .limit(query.size)
      .offset(query.page * query.size);
    return { totalCount: total?.value ?? 0, items: await this.views(groups) };
  }

  async detail(groupId: string): Promise<AdminReportGroupDetail> {
    const group = await this.find(groupId);
    const [view] = await this.views([group]);
    const [rows, targetTotal, history, sanctions, admin] = await Promise.all([
      this.db.select().from(reports).where(eq(reports.groupId, groupId)).orderBy(asc(reports.id)),
      this.db
        .select({ value: count() })
        .from(reports)
        .where(and(eq(reports.targetType, group.targetType), eq(reports.targetId, group.targetId))),
      this.db
        .select({ entry: reportGroupHistory, adminName: users.name })
        .from(reportGroupHistory)
        .leftJoin(users, eq(users.id, reportGroupHistory.adminId))
        .where(eq(reportGroupHistory.groupId, groupId))
        .orderBy(asc(reportGroupHistory.id)),
      group.targetType === 'USER' ? this.sanctions.historyOf(group.targetId) : Promise.resolve([]),
      group.adminId
        ? this.db.select({ name: users.name }).from(users).where(eq(users.id, group.adminId))
        : Promise.resolve([]),
    ]);
    return {
      ...(view as AdminReportGroup),
      reports: rows.map((r) => ({
        reportId: r.id,
        reason: r.reason,
        detail: r.detail,
        battleId: r.battleId,
        createdAt: r.createdAt.toISOString(),
      })),
      targetHistory: { reportCount: targetTotal[0]?.value ?? 0, sanctions },
      result:
        group.status === 'RESOLVED' && group.result && group.resolvedAt
          ? {
              result: group.result,
              memo: group.memo ?? '',
              adminName: admin[0]?.name ?? null,
              resolvedAt: group.resolvedAt.toISOString(),
            }
          : null,
      history: history.map(({ entry, adminName }) => ({
        status: entry.status,
        result: entry.result,
        memo: entry.memo,
        adminName,
        createdAt: entry.createdAt.toISOString(),
      })),
    };
  }

  /**
   * 처리 상태를 바꾼다. 처음 완료하면 묶음을 닫고(뒤의 신고는 새 묶음) 신고한 사람들에게 결과를 알린다.
   * 완료한 뒤에는 결과·메모만 고칠 수 있고, 바꿀 때마다 이력이 남는다
   */
  async update(
    admin: AuthUser,
    groupId: string,
    body: UpdateReportGroup,
    request: FastifyRequest,
  ): Promise<void> {
    const now = new Date();
    const resolvedNow = await this.db.transaction(async (tx) => {
      const [group] = await tx
        .select()
        .from(reportGroups)
        .where(eq(reportGroups.id, groupId))
        .for('update');
      if (!group) throw AdminReportErrors.notFound();
      if (group.status === 'RESOLVED' && body.status !== 'RESOLVED') {
        throw AdminReportErrors.alreadyResolved();
      }
      const resolving = body.status === 'RESOLVED';
      const firstResolve = resolving && group.status !== 'RESOLVED';
      await tx
        .update(reportGroups)
        .set({
          status: body.status,
          result: resolving ? (body.result ?? null) : null,
          memo: body.memo ?? null,
          adminId: admin.userId,
          ...(firstResolve ? { resolvedAt: now, openKey: null } : {}),
        })
        .where(eq(reportGroups.id, groupId));
      await tx.update(reports).set({ status: body.status }).where(eq(reports.groupId, groupId));
      await tx.insert(reportGroupHistory).values({
        id: newId(),
        groupId,
        status: body.status,
        result: resolving ? (body.result ?? null) : null,
        memo: body.memo ?? null,
        adminId: admin.userId,
      });
      await this.audit.record(
        {
          actorId: admin.userId,
          action: 'REPORT_UPDATE',
          targetType: 'REPORT_GROUP',
          targetId: groupId,
          detail: { status: body.status, result: body.result ?? null, memo: body.memo ?? null },
        },
        request,
        tx,
      );
      return firstResolve ? (body.result as ReportResult) : null;
    });
    if (resolvedNow) await this.notifyReporters(groupId, resolvedNow);
  }

  private async notifyReporters(groupId: string, result: ReportResult): Promise<void> {
    try {
      const reporters = await this.db
        .selectDistinct({ id: reports.reporterId })
        .from(reports)
        .where(eq(reports.groupId, groupId));
      await this.notifications.notify(
        reporters.map((r) => r.id),
        {
          type: 'REPORT_RESULT',
          title: '신고 처리 결과',
          body: RESULT_MESSAGES[result],
          route: '/notifications',
        },
      );
    } catch (error) {
      this.logger.warn(`신고 결과 알림 실패 (${groupId}): ${String(error)}`);
    }
  }

  private async find(groupId: string): Promise<ReportGroup> {
    const [group] = await this.db.select().from(reportGroups).where(eq(reportGroups.id, groupId));
    if (!group) throw AdminReportErrors.notFound();
    return group;
  }

  /** 묶음마다 사유·신고 수·대상 이름을 붙인다 */
  private async views(groups: ReportGroup[]): Promise<AdminReportGroup[]> {
    if (groups.length === 0) return [];
    const ids = groups.map((g) => g.id);
    const rows = await this.db
      .select({ groupId: reports.groupId, reason: reports.reason })
      .from(reports)
      .where(inArray(reports.groupId, ids));
    const byGroup = new Map<string, ReportReason[]>();
    for (const row of rows)
      byGroup.set(row.groupId, [...(byGroup.get(row.groupId) ?? []), row.reason]);
    const labels = await this.labels(groups);
    return groups.map((g) => {
      const reasons = byGroup.get(g.id) ?? [];
      return {
        reportGroupId: g.id,
        targetType: g.targetType,
        target: { id: g.targetId, label: labels.get(g.targetId) ?? '(삭제됨)' },
        reasons: [...new Set(reasons)],
        reportCount: reasons.length,
        status: g.status,
        lastReportedAt: g.lastReportedAt.toISOString(),
      };
    });
  }

  private async labels(groups: ReportGroup[]): Promise<Map<string, string>> {
    const idsOf = (type: ReportGroup['targetType']) =>
      groups.filter((g) => g.targetType === type).map((g) => g.targetId);
    const labels = new Map<string, string>();
    const userIds = idsOf('USER');
    if (userIds.length > 0) {
      for (const user of await this.db.select().from(users).where(inArray(users.id, userIds))) {
        labels.set(user.id, toUserSummary(user).name);
      }
    }
    const packIds = idsOf('PACK');
    if (packIds.length > 0) {
      for (const pack of await this.db
        .select({ id: packs.id, name: packs.name })
        .from(packs)
        .where(inArray(packs.id, packIds))) {
        labels.set(pack.id, pack.name);
      }
    }
    const wordIds = idsOf('WORD');
    if (wordIds.length > 0) {
      for (const word of await this.db
        .select({ id: words.id, english: words.english })
        .from(words)
        .where(inArray(words.id, wordIds))) {
        labels.set(word.id, word.english);
      }
    }
    return labels;
  }
}
