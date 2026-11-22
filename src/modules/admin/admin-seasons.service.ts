import { InjectQueue } from '@nestjs/bullmq';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, asc, count, countDistinct, desc, eq, inArray, ne } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { AuditLogService } from '../../common/audit/audit-log.service.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException } from '../../common/errors/app-exception.js';
import type { Page } from '../../common/pagination.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import {
  type RankingSeason,
  rankingSeasonExclusions,
  rankingSeasons,
  rankingSnapshots,
  reportGroups,
  type User,
  users,
} from '../../infra/db/schema/index.js';
import { CLOSE_SEASON_JOB, RANKING_QUEUE } from '../ranking/ranking.processor.js';
import { TOP_LIMIT } from '../ranking/ranking-query.service.js';
import { SeasonService } from '../ranking/season.service.js';
import { toUserSummary } from '../users/user-summary.js';
import { AdminUserErrors } from './admin-errors.js';
import type {
  AdminSeason,
  AdminSeasonDetail,
  AdminSeasonQuery,
  UpdateSeasonExclusions,
} from './admin-seasons.schemas.js';

export const AdminSeasonErrors = {
  notFound: () =>
    new AppException('ADMIN_SEASON_NOT_FOUND', '시즌을 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
  notFailed: () =>
    new AppException(
      'ADMIN_SEASON_NOT_FAILED',
      '마감에 실패한 시즌만 다시 실행할 수 있습니다.',
      HttpStatus.CONFLICT,
    ),
};

const SCHOOL = 'school';

@Injectable()
export class AdminSeasonsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(RANKING_QUEUE) private readonly queue: Queue,
    private readonly seasons: SeasonService,
    private readonly audit: AuditLogService,
  ) {}

  /** 최근 시즌부터 */
  async list(query: AdminSeasonQuery): Promise<Page<AdminSeason>> {
    const where = and(
      query.period ? eq(rankingSeasons.period, query.period) : undefined,
      query.status ? eq(rankingSeasons.status, query.status) : undefined,
    );
    const [total] = await this.db.select({ value: count() }).from(rankingSeasons).where(where);
    const rows = await this.db
      .select()
      .from(rankingSeasons)
      .where(where)
      .orderBy(desc(rankingSeasons.startsOn), asc(rankingSeasons.period), desc(rankingSeasons.id))
      .limit(query.size)
      .offset(query.page * query.size);
    const pending = await this.pendingReportCounts(rows.map((row) => row.id));
    return {
      totalCount: total?.value ?? 0,
      items: rows.map((row) => this.view(row, pending.get(row.id) ?? 0)),
    };
  }

  async detail(seasonId: string): Promise<AdminSeasonDetail> {
    const season = await this.find(seasonId);
    const [pending, school, exclusions] = await Promise.all([
      this.pendingReportCounts([seasonId]),
      this.db
        .select()
        .from(rankingSnapshots)
        .where(and(eq(rankingSnapshots.seasonId, seasonId), eq(rankingSnapshots.scope, SCHOOL)))
        .orderBy(asc(rankingSnapshots.position)),
      this.db
        .select()
        .from(rankingSeasonExclusions)
        .where(eq(rankingSeasonExclusions.seasonId, seasonId))
        .orderBy(asc(rankingSeasonExclusions.createdAt)),
    ]);
    const top: typeof school = [];
    for (const row of school) {
      // 제외되지 않은 사람의 순위는 마감 순서대로 커지므로 100위를 넘으면 멈춘다
      if (row.rank !== null && row.rank > TOP_LIMIT) break;
      top.push(row);
    }
    const people = await this.users([
      ...top.map((row) => row.userId),
      ...exclusions.flatMap((e) => (e.adminId ? [e.userId, e.adminId] : [e.userId])),
    ]);
    const excluded = new Set(exclusions.map((e) => e.userId));
    return {
      ...this.view(season, pending.get(seasonId) ?? 0),
      attempts: season.attempts,
      error: season.status === 'FAILED' ? season.lastError : null,
      ranking: top.flatMap((row) => {
        const user = people.get(row.userId);
        if (!user) return [];
        return [
          {
            rank: row.rank,
            user: toUserSummary(user),
            xp: row.xp,
            listed: row.listed,
            excluded: excluded.has(row.userId),
          },
        ];
      }),
      exclusions: exclusions.flatMap((e) => {
        const user = people.get(e.userId);
        if (!user) return [];
        return [
          {
            user: toUserSummary(user),
            reason: e.reason,
            adminName: e.adminId ? (people.get(e.adminId)?.name ?? null) : null,
            excludedAt: e.createdAt.toISOString(),
          },
        ];
      }),
    };
  }

  /**
   * 제외 대상을 통째로 바꾸고 그 시즌 스냅샷의 모든 범위 순위를 다시 매긴다.
   * 계속 제외되는 사용자는 처음 제외한 사유·관리자를 그대로 둔다
   */
  async updateExclusions(
    admin: AuthUser,
    seasonId: string,
    body: UpdateSeasonExclusions,
    request: FastifyRequest,
  ): Promise<void> {
    const wanted = [...new Set(body.userIds)];
    await this.db.transaction(async (tx) => {
      const [season] = await tx
        .select({ id: rankingSeasons.id })
        .from(rankingSeasons)
        .where(eq(rankingSeasons.id, seasonId))
        .for('update');
      if (!season) throw AdminSeasonErrors.notFound();
      if (wanted.length > 0) {
        const found = await tx
          .select({ id: users.id })
          .from(users)
          .where(inArray(users.id, wanted));
        if (found.length !== wanted.length) throw AdminUserErrors.userNotFound();
      }
      const current = await tx
        .select({ userId: rankingSeasonExclusions.userId })
        .from(rankingSeasonExclusions)
        .where(eq(rankingSeasonExclusions.seasonId, seasonId));
      const before = new Set(current.map((e) => e.userId));
      const added = wanted.filter((id) => !before.has(id));
      const removed = [...before].filter((id) => !wanted.includes(id));
      if (removed.length > 0) {
        await tx
          .delete(rankingSeasonExclusions)
          .where(
            and(
              eq(rankingSeasonExclusions.seasonId, seasonId),
              inArray(rankingSeasonExclusions.userId, removed),
            ),
          );
      }
      if (added.length > 0) {
        await tx.insert(rankingSeasonExclusions).values(
          added.map((userId) => ({
            seasonId,
            userId,
            reason: body.reason,
            adminId: admin.userId,
          })),
        );
      }
      if (added.length > 0 || removed.length > 0) await this.seasons.rerank(tx, seasonId);
      await this.audit.record(
        {
          actorId: admin.userId,
          action: 'SEASON_EXCLUSIONS_UPDATE',
          targetType: 'SEASON',
          targetId: seasonId,
          detail: { userIds: wanted, added, removed, reason: body.reason },
        },
        request,
        tx,
      );
    });
  }

  /** 큐에 넣고 바로 돌려준다(202). 진행은 GET /admin/jobs의 SEASON_CLOSE에서 본다 */
  async rerun(admin: AuthUser, seasonId: string, request: FastifyRequest) {
    const season = await this.find(seasonId);
    if (season.status !== 'FAILED') throw AdminSeasonErrors.notFailed();
    await this.queue.add(
      CLOSE_SEASON_JOB,
      { seasonId, manual: true },
      { removeOnComplete: 100, removeOnFail: 100 },
    );
    await this.audit.record(
      {
        actorId: admin.userId,
        action: 'SEASON_RERUN',
        targetType: 'SEASON',
        targetId: seasonId,
        detail: { period: season.period, periodKey: season.periodKey },
      },
      request,
    );
    return { seasonId, queuedAt: new Date().toISOString() };
  }

  private async find(seasonId: string): Promise<RankingSeason> {
    const [season] = await this.db
      .select()
      .from(rankingSeasons)
      .where(eq(rankingSeasons.id, seasonId));
    if (!season) throw AdminSeasonErrors.notFound();
    return season;
  }

  private view(season: RankingSeason, pendingReportCount: number): AdminSeason {
    return {
      seasonId: season.id,
      period: season.period,
      periodKey: season.periodKey,
      startDate: season.startsOn,
      endDate: Temporal.PlainDate.from(season.endsOn).subtract({ days: 1 }).toString(),
      status: season.status,
      pendingReportCount,
      closedAt: season.confirmedAt?.toISOString() ?? null,
    };
  }

  private async pendingReportCounts(seasonIds: string[]): Promise<Map<string, number>> {
    if (seasonIds.length === 0) return new Map();
    const rows = await this.db
      .select({ seasonId: rankingSnapshots.seasonId, value: countDistinct(reportGroups.id) })
      .from(rankingSnapshots)
      .innerJoin(
        reportGroups,
        and(
          eq(reportGroups.targetType, 'USER'),
          eq(reportGroups.targetId, rankingSnapshots.userId),
          ne(reportGroups.status, 'RESOLVED'),
        ),
      )
      .where(and(inArray(rankingSnapshots.seasonId, seasonIds), eq(rankingSnapshots.scope, SCHOOL)))
      .groupBy(rankingSnapshots.seasonId);
    return new Map(rows.map((row) => [row.seasonId, row.value]));
  }

  private async users(ids: string[]): Promise<Map<string, User>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db.select().from(users).where(inArray(users.id, unique));
    return new Map(rows.map((row) => [row.id, row]));
  }
}
