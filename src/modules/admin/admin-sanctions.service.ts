import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { AuditLogService } from '../../common/audit/audit-log.service.js';
import { AccountBlockService } from '../../common/auth/account-block.service.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException } from '../../common/errors/app-exception.js';
import { kstDate } from '../../common/time/kst.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { sanctions, users, xpLedger } from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { SessionService } from '../auth/session.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RankingService } from '../ranking/ranking.service.js';
import { AdminUserErrors } from './admin-errors.js';
import type { ApplySanction } from './admin-sanctions.schemas.js';

export const SanctionErrors = {
  self: () =>
    new AppException('ADMIN_SELF_ACTION', '자기 자신에게는 할 수 없습니다.', HttpStatus.CONFLICT),
  notSuspended: () =>
    new AppException('ADMIN_NOT_SUSPENDED', '정지된 계정이 아닙니다.', HttpStatus.CONFLICT),
};

const TYPE_NAMES = {
  WARNING: '경고',
  XP_REVOKE: 'XP 회수',
  SUSPEND: '이용 정지',
  BAN: '영구 정지',
} as const;

@Injectable()
export class AdminSanctionsService {
  private readonly logger = new Logger(AdminSanctionsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditLogService,
    private readonly blocks: AccountBlockService,
    private readonly sessions: SessionService,
    private readonly notifications: NotificationsService,
    private readonly ranking: RankingService,
  ) {}

  /**
   * 정지·영구 정지는 계정 상태를 바꾸고 모든 세션과 남은 액세스 토큰을 막는다(사유는 로그인할 때 안내).
   * 경고·XP 회수는 SANCTION 알림으로 알린다
   */
  async apply(
    admin: AuthUser,
    body: ApplySanction,
    request: FastifyRequest,
  ): Promise<{ sanctionId: string }> {
    if (body.userId === admin.userId) throw SanctionErrors.self();
    const now = new Date();
    const sanctionId = newId();
    const suspends = body.type === 'SUSPEND' || body.type === 'BAN';
    // 커밋과 차단 사이에 실패해 남은 토큰이 살아 있지 않도록 먼저 막고, 롤백되면 푼다
    const [current] = await this.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, body.userId));
    const alreadySuspended = current?.status === 'SUSPENDED';
    if (suspends) await this.blocks.block(body.userId);
    const result = await this.db
      .transaction(async (tx) => {
        const [user] = await tx.select().from(users).where(eq(users.id, body.userId)).for('update');
        if (!user || user.status === 'WITHDRAWN') throw AdminUserErrors.userNotFound();

        let revokedXp: number | null = null;
        if (body.type === 'XP_REVOKE') {
          // 가진 것보다 많이 회수하지 않는다
          revokedXp = Math.min(body.revokeXp ?? 0, user.totalXp);
          if (revokedXp > 0) {
            await tx
              .update(users)
              .set({ totalXp: user.totalXp - revokedXp })
              .where(eq(users.id, user.id));
            const ledgerId = newId();
            await tx.insert(xpLedger).values({
              id: ledgerId,
              userId: user.id,
              source: 'ADMIN_ADJUST',
              refKey: `sanction:${sanctionId}`,
              amount: -revokedXp,
              date: kstDate(now),
            });
          }
        }
        const until = body.type === 'SUSPEND' ? new Date(body.suspendedUntil as string) : null;
        if (suspends) {
          await tx
            .update(users)
            .set({ status: 'SUSPENDED', suspendedUntil: until, suspendReason: body.reason })
            .where(eq(users.id, user.id));
          await this.sessions.revokeAll(user.id, tx);
        }
        await tx.insert(sanctions).values({
          id: sanctionId,
          userId: user.id,
          type: body.type,
          reason: body.reason,
          suspendedUntil: until,
          revokedXp,
          reportGroupId: body.reportGroupId ?? null,
          adminId: admin.userId,
        });
        await this.audit.record(
          {
            actorId: admin.userId,
            action: 'SANCTION_APPLY',
            targetType: 'USER',
            targetId: user.id,
            detail: {
              sanctionId,
              type: body.type,
              reason: body.reason,
              suspendedUntil: until?.toISOString() ?? null,
              revokedXp,
              reportGroupId: body.reportGroupId ?? null,
            },
          },
          request,
          tx,
        );
        return { revokedXp };
      })
      .catch(async (error: unknown) => {
        if (suspends && !alreadySuspended) {
          // 그사이 탈퇴했으면 탈퇴 차단으로 되돌린다 (풀면 탈퇴자의 남은 토큰이 살아난다)
          const [latest] = await this.db
            .select({ status: users.status })
            .from(users)
            .where(eq(users.id, body.userId))
            .catch(() => []);
          const restore =
            latest?.status === 'WITHDRAWN'
              ? this.blocks.block(body.userId, 'WITHDRAWN')
              : this.blocks.unblock(body.userId);
          await restore.catch(() => undefined);
        }
        throw error;
      });

    if (!suspends) {
      if (result.revokedXp) await this.ranking.adjustXp(body.userId, -result.revokedXp, now);
      const extra = result.revokedXp ? ` (XP ${result.revokedXp} 회수)` : '';
      await this.notifications
        .notify([body.userId], {
          type: 'SANCTION',
          title: TYPE_NAMES[body.type],
          body: `${body.reason}${extra}`,
          route: '/notifications',
        })
        .catch((error: unknown) =>
          this.logger.warn(`제재 알림 실패 (${body.userId}): ${String(error)}`),
        );
    }
    return { sanctionId };
  }

  /** 정지를 푼다 (정지 이력은 남는다) */
  async unsuspend(
    admin: AuthUser,
    userId: string,
    reason: string,
    request: FastifyRequest,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (!user || user.status === 'WITHDRAWN') throw AdminUserErrors.userNotFound();
      if (user.status !== 'SUSPENDED') throw SanctionErrors.notSuspended();
      await tx
        .update(users)
        .set({ status: 'ACTIVE', suspendedUntil: null, suspendReason: null })
        .where(eq(users.id, userId));
      await this.audit.record(
        {
          actorId: admin.userId,
          action: 'USER_UNSUSPEND',
          targetType: 'USER',
          targetId: userId,
          detail: { reason },
        },
        request,
        tx,
      );
    });
    await this.blocks.unblock(userId);
  }

  /** 사용자 상세의 제재 이력 (최신순) */
  async historyOf(userId: string) {
    const rows = await this.db
      .select({ sanction: sanctions, adminName: users.name })
      .from(sanctions)
      .leftJoin(users, eq(users.id, sanctions.adminId))
      .where(eq(sanctions.userId, userId))
      .orderBy(desc(sanctions.id));
    return rows.map(({ sanction, adminName }) => ({
      sanctionId: sanction.id,
      type: sanction.type,
      reason: sanction.reason,
      until: sanction.suspendedUntil?.toISOString() ?? null,
      revokedXp: sanction.revokedXp,
      adminName,
      createdAt: sanction.createdAt.toISOString(),
    }));
  }
}
