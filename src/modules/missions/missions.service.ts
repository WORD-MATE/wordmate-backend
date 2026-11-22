import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import type { MissionPeriod } from '../../common/enums.js';
import { AppException } from '../../common/errors/app-exception.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { type Mission, missions, userMissions, users } from '../../infra/db/schema/index.js';
import { RankingService } from '../ranking/ranking.service.js';
import { XpService } from '../xp/xp.service.js';
import { expiresAtOf, missionPeriodKey } from './mission-progress.js';
import type { MissionItem } from './missions.schemas.js';

export const MissionErrors = {
  notFound: () =>
    new AppException('MISSION_NOT_FOUND', '미션을 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
  notClaimable: () =>
    new AppException(
      'MISSION_NOT_CLAIMABLE',
      '아직 달성하지 않은 미션입니다.',
      HttpStatus.CONFLICT,
    ),
  alreadyClaimed: () =>
    new AppException('MISSION_ALREADY_CLAIMED', '이미 보상을 받았습니다.', HttpStatus.CONFLICT),
};

@Injectable()
export class MissionsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly xp: XpService,
    private readonly ranking: RankingService,
  ) {}

  /** 이번 기간(일일은 오늘, 주간은 이번 주) 미션. 오늘의 문장 미션은 06:00 기준 날짜로 센다 */
  async list(user: AuthUser, now = new Date()) {
    const defs = await this.db
      .select()
      .from(missions)
      .where(eq(missions.active, true))
      .orderBy(asc(missions.sortOrder), asc(missions.code));
    const keys = [...new Set(defs.map((d) => missionPeriodKey(d, now)))];
    const rows =
      defs.length === 0
        ? []
        : await this.db
            .select()
            .from(userMissions)
            .where(
              and(
                eq(userMissions.userId, user.userId),
                inArray(
                  userMissions.missionId,
                  defs.map((d) => d.id),
                ),
                inArray(userMissions.periodKey, keys),
              ),
            );
    const items = defs.map((def) => {
      const row = rows.find(
        (r) => r.missionId === def.id && r.periodKey === missionPeriodKey(def, now),
      );
      return this.view(def, row?.progress ?? 0, row?.claimedAt ?? null, now);
    });
    return {
      daily: items.filter((m) => m.period === 'DAILY'),
      weekly: items.filter((m) => m.period === 'WEEKLY'),
    };
  }

  /**
   * 이번 기간 보상을 한 번 받는다. 조건부 업데이트로 두 번 받지 않게 하고 XP를 같은 트랜잭션에서 준다.
   * 하루 상한에 걸려 일부만 받아도 받은 것으로 끝난다
   */
  async claim(user: AuthUser, missionId: string) {
    const [def] = await this.db
      .select()
      .from(missions)
      .where(and(eq(missions.id, missionId), eq(missions.active, true)));
    if (!def) throw MissionErrors.notFound();
    const now = new Date();
    const periodKey = missionPeriodKey(def, now);
    const target = and(
      eq(userMissions.userId, user.userId),
      eq(userMissions.missionId, def.id),
      eq(userMissions.periodKey, periodKey),
    );

    const xp = await this.db.transaction(async (tx) => {
      // 진행을 올리는 쪽과 같은 순서로 사용자 행부터 잠근다
      await tx.select({ id: users.id }).from(users).where(eq(users.id, user.userId)).for('update');
      const [result] = await tx
        .update(userMissions)
        .set({ claimedAt: now })
        .where(
          and(
            target,
            isNull(userMissions.claimedAt),
            sql`${userMissions.progress} >= ${def.target}`,
          ),
        );
      if (result.affectedRows === 0) {
        const [row] = await tx
          .select({ claimedAt: userMissions.claimedAt })
          .from(userMissions)
          .where(target);
        throw row?.claimedAt ? MissionErrors.alreadyClaimed() : MissionErrors.notClaimable();
      }
      const grant = await this.xp.grant(
        tx,
        user.userId,
        [{ source: 'MISSION', refKey: `${def.id}:${periodKey}`, amount: def.rewardXp }],
        now,
      );
      return {
        earned: grant.earned,
        blockedReason: grant.capped ? ('DAILY_CAP' as const) : null,
        todayTotal: grant.todayTotal,
      };
    });
    await this.ranking.addXp(user.userId, xp.earned, now);
    return { xp };
  }

  /** 홈 카드: 일일 미션 */
  async dailyCard(user: AuthUser) {
    const { daily } = await this.list(user);
    return daily.map((m) => ({
      missionId: m.missionId,
      title: m.title,
      progress: m.progress,
      target: m.target,
      status: m.status,
    }));
  }

  private view(def: Mission, progress: number, claimedAt: Date | null, now: Date): MissionItem {
    const period: MissionPeriod = def.period;
    return {
      missionId: def.id,
      period,
      title: def.title,
      progress: Math.min(progress, def.target),
      target: def.target,
      rewardXp: def.rewardXp,
      status: claimedAt ? 'CLAIMED' : progress >= def.target ? 'CLAIMABLE' : 'IN_PROGRESS',
      expiresAt: expiresAtOf(period, now).toISOString(),
    };
  }
}
