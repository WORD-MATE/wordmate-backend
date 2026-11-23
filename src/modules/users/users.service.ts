import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { z } from 'zod';
import { AuthErrors } from '../../common/auth/auth-errors.js';
import { AppException } from '../../common/errors/app-exception.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { badges, type NewUser, userBadges, users } from '../../infra/db/schema/index.js';
import { DEFAULT_AVATAR_ID, isAvatarId } from './avatars.js';
import { type Me, toMe } from './me.schema.js';
import { TeacherClassService } from './teacher-class.service.js';
import type { PrivacySettings, UpdateProfile } from './users.schemas.js';

export const ProfileErrors = {
  avatarNotFound: () =>
    new AppException('USER_AVATAR_NOT_FOUND', '없는 아바타입니다.', HttpStatus.BAD_REQUEST),
  badgeNotOwned: () =>
    new AppException(
      'USER_BADGE_NOT_OWNED',
      '가지고 있지 않은 배지입니다.',
      HttpStatus.BAD_REQUEST,
    ),
};

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly teacherClasses: TeacherClassService,
  ) {}

  async me(userId: string): Promise<Me> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user || user.status === 'WITHDRAWN') throw AuthErrors.invalidToken();
    return toMe(user, user.role === 'TEACHER' ? await this.teacherClasses.list(user.id) : []);
  }

  /** 생략한 항목은 그대로 두고 null은 해제한다(아바타는 기본값으로). 이름·학번·학년·반은 DataGSM 값이라 바꿀 수 없다 */
  async updateProfile(userId: string, body: z.infer<typeof UpdateProfile>): Promise<Me> {
    const changes: Partial<NewUser> = {};
    if ('avatarId' in body) {
      const avatarId = body.avatarId ?? DEFAULT_AVATAR_ID;
      if (!isAvatarId(avatarId)) throw ProfileErrors.avatarNotFound();
      changes.avatarId = avatarId;
    }
    await this.db.transaction(async (tx) => {
      // 탈퇴가 배지를 지우는 것과 겹치지 않게 사용자 행부터 잠근다
      const [user] = await tx
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      if (!user || user.status === 'WITHDRAWN') throw AuthErrors.invalidToken();
      if ('representativeBadgeId' in body) {
        const badgeId = body.representativeBadgeId ?? null;
        if (badgeId !== null) {
          const [owned] = await tx
            .select({ badgeId: userBadges.badgeId })
            .from(userBadges)
            .innerJoin(badges, eq(badges.id, userBadges.badgeId))
            .where(
              and(
                eq(userBadges.userId, userId),
                eq(userBadges.badgeId, badgeId),
                eq(badges.active, true),
              ),
            );
          if (!owned) throw ProfileErrors.badgeNotOwned();
        }
        changes.representativeBadgeId = badgeId;
      }
      if (Object.keys(changes).length > 0) {
        await tx.update(users).set(changes).where(eq(users.id, userId));
      }
    });
    return this.me(userId);
  }

  /** 랭킹 첫 진입 안내와 설정 화면이 같이 쓴다. 비공개여도 랭킹 점수는 쌓이고 목록에서만 빠진다 */
  async updatePrivacy(userId: string, rankingPublic: boolean): Promise<PrivacySettings> {
    await this.db
      .update(users)
      .set({ rankingPublic, rankingOnboarded: true })
      .where(eq(users.id, userId));
    return { rankingPublic, rankingOnboarded: true };
  }
}
