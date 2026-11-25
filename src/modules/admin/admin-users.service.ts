import { Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, like, max, or, type SQL, sql, sum } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { AuditLogService } from '../../common/audit/audit-log.service.js';
import { AccountBlockService } from '../../common/auth/account-block.service.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import type { Page } from '../../common/pagination.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import {
  battleResults,
  dailyStudyStats,
  reports,
  studyRecords,
  type User,
  users,
} from '../../infra/db/schema/index.js';
import { BadgesService } from '../badges/badges.service.js';
import { ClassesService } from '../classes/classes.service.js';
import { RankingService } from '../ranking/ranking.service.js';
import { levelOf } from '../users/me.schema.js';
import { TeacherClassService } from '../users/teacher-class.service.js';
import { toUserSummary } from '../users/user-summary.js';
import { XpService } from '../xp/xp.service.js';
import { AdminUserErrors } from './admin-errors.js';
import { AdminSanctionsService } from './admin-sanctions.service.js';
import type {
  AdminUserDetail,
  AdminUserItem,
  AdminUserQuery,
  XpAdjustment,
} from './admin-users.schemas.js';

const toItem = (user: User): AdminUserItem => ({
  user: toUserSummary(user),
  studentNumber: user.studentNumber,
  number: user.number,
  role: user.role,
  isAdmin: user.isAdmin,
  status: user.status,
  createdAt: user.createdAt.toISOString(),
});

@Injectable()
export class AdminUsersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditLogService,
    private readonly teacherClasses: TeacherClassService,
    private readonly classes: ClassesService,
    private readonly ranking: RankingService,
    private readonly badges: BadgesService,
    private readonly sanctions: AdminSanctionsService,
    private readonly blocks: AccountBlockService,
    private readonly xp: XpService,
  ) {}

  /** 조회도 감사 로그에 남긴다 (개인정보 열람 기록) */
  async search(
    admin: AuthUser,
    query: AdminUserQuery,
    request: FastifyRequest,
  ): Promise<Page<AdminUserItem>> {
    const keyword = query.q?.replace(/[%_\\]/g, (c) => `\\${c}`);
    const conditions: (SQL | undefined)[] = [
      keyword
        ? or(like(users.studentNumber, `${keyword}%`), like(users.name, `%${keyword}%`))
        : undefined,
      query.role ? eq(users.role, query.role) : undefined,
      query.isAdmin !== undefined ? eq(users.isAdmin, query.isAdmin) : undefined,
      query.status ? eq(users.status, query.status) : undefined,
    ];
    const where = and(...conditions);
    const [total] = await this.db.select({ value: count() }).from(users).where(where);
    const rows = await this.db
      .select()
      .from(users)
      .where(where)
      .orderBy(desc(users.id))
      .limit(query.size)
      .offset(query.page * query.size);
    await this.audit.record(
      {
        actorId: admin.userId,
        action: 'ADMIN_USER_SEARCH',
        targetType: 'USER',
        targetId: null,
        detail: { ...query },
      },
      request,
    );
    return { totalCount: total?.value ?? 0, items: rows.map(toItem) };
  }

  async detail(admin: AuthUser, userId: string, request: FastifyRequest): Promise<AdminUserDetail> {
    const user = await this.find(userId);
    const [classes, study, lastRecord, battle, reported, sanctionHistory] = await Promise.all([
      user.role === 'TEACHER' ? this.teacherClasses.list(userId) : Promise.resolve([]),
      this.db
        .select({
          solved: sum(dailyStudyStats.solvedCount),
          graded: sum(dailyStudyStats.gradedCount),
          correct: sum(dailyStudyStats.correctCount),
        })
        .from(dailyStudyStats)
        .where(eq(dailyStudyStats.userId, userId)),
      this.db
        .select({ at: max(studyRecords.completedAt) })
        .from(studyRecords)
        .where(eq(studyRecords.userId, userId)),
      this.db
        .select({
          total: count(),
          wins: sum(sql`${battleResults.outcome} = 'WIN'`),
          left: sum(sql`${battleResults.outcome} = 'LEFT'`),
        })
        .from(battleResults)
        .where(eq(battleResults.userId, userId)),
      this.db
        .select({ value: count() })
        .from(reports)
        .where(and(eq(reports.targetType, 'USER'), eq(reports.targetId, userId))),
      this.sanctions.historyOf(userId),
    ]);
    await this.audit.record(
      {
        actorId: admin.userId,
        action: 'ADMIN_USER_VIEW',
        targetType: 'USER',
        targetId: userId,
        detail: {},
      },
      request,
    );
    const graded = Number(study[0]?.graded ?? 0);
    const lastAt = lastRecord[0]?.at;
    return {
      ...toItem(user),
      suspendedUntil: user.suspendedUntil?.toISOString() ?? null,
      teacherClasses: classes,
      level: levelOf(user.totalXp),
      studySummary: {
        solvedCount: Number(study[0]?.solved ?? 0),
        accuracy:
          graded > 0 ? Math.round((Number(study[0]?.correct ?? 0) / graded) * 1000) / 10 : null,
        lastStudiedAt: lastAt ? new Date(lastAt).toISOString() : null,
      },
      battleSummary: {
        total: battle[0]?.total ?? 0,
        winCount: Number(battle[0]?.wins ?? 0),
        leftCount: Number(battle[0]?.left ?? 0),
      },
      reportCount: reported[0]?.value ?? 0,
      sanctions: sanctionHistory,
    };
  }

  /**
   * 관리자 행을 모두 잠근 뒤 세어 동시에 회수해도 마지막 관리자가 남는다.
   * 회수하면 이미 받은 토큰으로 관리자 API를 계속 쓰지 못하게 커밋 전에 막는다.
   * 동시에 회수·재부여해도 마지막에 커밋한 쪽이 표시를 정하도록 대상 행을 잠근 뒤에 다시 세우거나 지운다
   */
  async setAdmin(
    admin: AuthUser,
    userId: string,
    isAdmin: boolean,
    request: FastifyRequest,
  ): Promise<void> {
    if (!isAdmin) await this.blocks.revokeAdmin(userId);
    await this.db
      .transaction(async (tx) => {
        const admins = await tx
          .select({ id: users.id, status: users.status })
          .from(users)
          .where(eq(users.isAdmin, true))
          .for('update');
        const activeAdmins = admins.filter((a) => a.status === 'ACTIVE');
        const [target] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
        if (!target || target.status === 'WITHDRAWN') throw AdminUserErrors.userNotFound();
        if (isAdmin) await this.blocks.restoreAdmin(userId);
        else await this.blocks.revokeAdmin(userId);
        if (target.isAdmin === isAdmin) return;
        // 활동 중인 관리자가 하나도 남지 않으면 안 된다 (정지·휴면 관리자는 관리할 수 없음)
        if (!isAdmin && activeAdmins.every((a) => a.id === userId))
          throw AdminUserErrors.lastAdmin();
        await tx.update(users).set({ isAdmin }).where(eq(users.id, userId));
        await this.audit.record(
          {
            actorId: admin.userId,
            action: isAdmin ? 'ADMIN_GRANT' : 'ADMIN_REVOKE',
            targetType: 'USER',
            targetId: userId,
            detail: {},
          },
          request,
          tx,
        );
      })
      .catch(async (error: unknown) => {
        await this.syncAdminMark(userId).catch(() => {});
        throw error;
      });
  }

  /** 실패하면 표시를 실제 권한에 맞춘다 (관리자가 아닌데 남은 예전 토큰은 계속 막는다) */
  private async syncAdminMark(userId: string): Promise<void> {
    const [row] = await this.db
      .select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, userId));
    if (row?.isAdmin) await this.blocks.restoreAdmin(userId);
    else await this.blocks.revokeAdmin(userId);
  }

  async setClasses(admin: AuthUser, userId: string, classIds: string[], request: FastifyRequest) {
    const user = await this.find(userId);
    if (user.role !== 'TEACHER') throw AdminUserErrors.notTeacher();
    return this.classes.setTeacherClasses(userId, classIds, request, admin.userId);
  }

  /** 하루 상한을 적용하지 않고, 하루 상한 계산에도 넣지 않는다 (출처 ADMIN_ADJUST) */
  async adjustXp(
    admin: AuthUser,
    userId: string,
    body: XpAdjustment,
    request: FastifyRequest,
  ): Promise<{ totalXp: number; level: number }> {
    const now = new Date();
    const totalXp = await this.db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (!user || user.status === 'WITHDRAWN') throw AdminUserErrors.userNotFound();
      const next = user.totalXp + body.delta;
      if (next < 0) throw AdminUserErrors.xpNegative();
      await this.xp.adjust(tx, userId, body.delta, undefined, now);
      await this.audit.record(
        {
          actorId: admin.userId,
          action: 'XP_ADJUST',
          targetType: 'USER',
          targetId: userId,
          detail: { delta: body.delta, reason: body.reason, before: user.totalXp, after: next },
        },
        request,
        tx,
      );
      return next;
    });
    await this.ranking.adjustXp(userId, body.delta, now);
    if (body.delta > 0) await this.badges.evaluate(userId);
    return { totalXp, level: levelOf(totalXp).level };
  }

  private async find(userId: string): Promise<User> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user || user.status === 'WITHDRAWN') throw AdminUserErrors.userNotFound();
    return user;
  }
}
