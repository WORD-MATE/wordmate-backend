import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, count, eq, isNotNull } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import type { BadgeMetric } from '../../common/enums.js';
import { AppException } from '../../common/errors/app-exception.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import {
  badges,
  battleResults,
  studyRecords,
  userBadges,
  userStreaks,
  users,
} from '../../infra/db/schema/index.js';
import { NotificationsService } from '../notifications/notifications.service.js';

export const BadgeErrors = {
  userNotFound: () =>
    new AppException('USER_NOT_FOUND', '사용자를 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
};

@Injectable()
export class BadgesService {
  private readonly logger = new Logger(BadgesService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly notifications: NotificationsService,
  ) {}

  /** 내 배지는 전체와 획득 여부, 다른 사람은 획득한 것만(랭킹 비공개면 빈 배열) */
  async list(user: AuthUser, userId?: string) {
    const targetId = userId ?? user.userId;
    const mine = targetId === user.userId;
    if (!mine) {
      const [target] = await this.db
        .select({ status: users.status, rankingPublic: users.rankingPublic })
        .from(users)
        .where(eq(users.id, targetId));
      if (!target || target.status === 'WITHDRAWN') throw BadgeErrors.userNotFound();
      if (!target.rankingPublic) return [];
    }
    const defs = await this.db
      .select()
      .from(badges)
      .where(eq(badges.active, true))
      .orderBy(asc(badges.sortOrder), asc(badges.code));
    const earned = new Map(
      (
        await this.db
          .select({ badgeId: userBadges.badgeId, earnedAt: userBadges.earnedAt })
          .from(userBadges)
          .where(eq(userBadges.userId, targetId))
      ).map((row) => [row.badgeId, row.earnedAt]),
    );
    return defs
      .filter((def) => mine || earned.has(def.id))
      .map((def) => ({
        badgeId: def.id,
        type: def.type,
        name: def.name,
        description: def.description,
        condition: def.conditionText,
        imageUrl: def.imageUrl,
        earned: earned.has(def.id),
        earnedAt: earned.get(def.id)?.toISOString() ?? null,
      }));
  }

  /**
   * 활동이 커밋된 뒤 부른다. 아직 없는 업적 배지의 조건을 모두 다시 보고 새로 얻은 배지를 알린다.
   * 이미 받은 배지는 유니크 키로 건너뛰어 여러 번 불려도 한 번만 준다. 실패해도 요청은 성공으로 둔다
   */
  async evaluate(userId: string): Promise<void> {
    try {
      for (const def of await this.reached(userId)) {
        // 배지마다 따로 처리해 하나가 실패해도 나머지는 주고 알린다
        try {
          const [result] = await this.db
            .insert(userBadges)
            .ignore()
            .values({ userId, badgeId: def.id, earnedAt: new Date() });
          if (result.affectedRows === 0) continue;
          await this.notifications.notify([userId], {
            type: 'BADGE_EARNED',
            title: '배지 획득',
            body: `'${def.name}' 배지를 얻었어요.`,
            route: '/badges',
          });
        } catch (error) {
          this.logger.error(`배지 지급 실패 (${userId}, ${def.code}): ${String(error)}`);
        }
      }
    } catch (error) {
      this.logger.error(`배지 평가 실패 (${userId}): ${String(error)}`);
    }
  }

  /** 아직 없는 업적 배지 가운데 조건을 채운 것 */
  private async reached(userId: string) {
    const owned = await this.db
      .select({ badgeId: userBadges.badgeId })
      .from(userBadges)
      .where(eq(userBadges.userId, userId));
    const ownedIds = new Set(owned.map((row) => row.badgeId));
    const candidates = (
      await this.db
        .select()
        .from(badges)
        .where(
          and(eq(badges.active, true), eq(badges.type, 'ACHIEVEMENT'), isNotNull(badges.metric)),
        )
    ).filter((def) => !ownedIds.has(def.id));
    if (candidates.length === 0) return candidates;

    const metrics = new Set(candidates.map((def) => def.metric as BadgeMetric));
    const values = new Map<BadgeMetric, number>();
    for (const metric of metrics) values.set(metric, await this.valueOf(userId, metric));
    return candidates.filter(
      (def) => (values.get(def.metric as BadgeMetric) ?? 0) >= (def.threshold ?? Infinity),
    );
  }

  private async valueOf(userId: string, metric: BadgeMetric): Promise<number> {
    switch (metric) {
      case 'TOTAL_XP': {
        const [row] = await this.db
          .select({ value: users.totalXp })
          .from(users)
          .where(eq(users.id, userId));
        return row?.value ?? 0;
      }
      case 'STUDY_COUNT': {
        const [row] = await this.db
          .select({ value: count() })
          .from(studyRecords)
          .where(eq(studyRecords.userId, userId));
        return row?.value ?? 0;
      }
      case 'BATTLE_WINS': {
        const [row] = await this.db
          .select({ value: count() })
          .from(battleResults)
          .where(and(eq(battleResults.userId, userId), eq(battleResults.outcome, 'WIN')));
        return row?.value ?? 0;
      }
      case 'STUDY_STREAK':
      case 'MORNING_STREAK': {
        const [row] = await this.db
          .select({ value: userStreaks.best })
          .from(userStreaks)
          .where(
            and(
              eq(userStreaks.userId, userId),
              eq(userStreaks.kind, metric === 'STUDY_STREAK' ? 'STUDY' : 'MORNING'),
            ),
          );
        return row?.value ?? 0;
      }
    }
  }
}
