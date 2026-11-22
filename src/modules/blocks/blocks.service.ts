import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException } from '../../common/errors/app-exception.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { blocks, users } from '../../infra/db/schema/index.js';
import { FriendsService } from '../friends/friends.service.js';
import { toUserSummary } from '../users/user-summary.js';

export const BlockErrors = {
  self: () =>
    new AppException('BLOCK_SELF', '자기 자신은 차단할 수 없습니다.', HttpStatus.BAD_REQUEST),
  notAllowed: () =>
    new AppException('BLOCK_NOT_ALLOWED', '차단할 수 없는 사용자입니다.', HttpStatus.FORBIDDEN),
  userNotFound: () =>
    new AppException('USER_NOT_FOUND', '사용자를 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
  already: () =>
    new AppException('BLOCK_ALREADY', '이미 차단한 사용자입니다.', HttpStatus.CONFLICT),
  notFound: () =>
    new AppException('BLOCK_NOT_FOUND', '차단한 사용자가 아닙니다.', HttpStatus.NOT_FOUND),
};

@Injectable()
export class BlocksService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly friends: FriendsService,
  ) {}

  async list(user: AuthUser) {
    const rows = await this.db
      .select({ createdAt: blocks.createdAt, user: users })
      .from(blocks)
      .innerJoin(users, eq(users.id, blocks.blockedId))
      .where(eq(blocks.blockerId, user.userId))
      .orderBy(desc(blocks.createdAt));
    return rows.map((row) => ({
      user: toUserSummary(row.user),
      blockedAt: row.createdAt.toISOString(),
    }));
  }

  /** 친구 관계와 대기 중인 친구 요청을 함께 지운다. 상대에게 알리지 않는다 */
  async block(user: AuthUser, targetId: string): Promise<void> {
    if (targetId === user.userId) throw BlockErrors.self();
    await this.db.transaction(async (tx) => {
      // 친구 요청·수락과 같은 순서로 두 사용자를 잠가 차단과 동시에 친구가 되지 않게 한다
      await this.friends.lockUsers(tx, [user.userId, targetId]);
      const [target] = await tx
        .select({ role: users.role, status: users.status })
        .from(users)
        .where(eq(users.id, targetId));
      if (!target || target.status === 'WITHDRAWN') throw BlockErrors.userNotFound();
      if (target.role !== 'STUDENT') throw BlockErrors.notAllowed();
      const [existing] = await tx
        .select({ blockerId: blocks.blockerId })
        .from(blocks)
        .where(and(eq(blocks.blockerId, user.userId), eq(blocks.blockedId, targetId)));
      if (existing) throw BlockErrors.already();
      await tx.insert(blocks).values({ blockerId: user.userId, blockedId: targetId });
      await this.friends.severInTx(tx, user.userId, targetId);
    });
  }

  /** 풀어도 지운 친구 관계는 되살리지 않는다 */
  async unblock(user: AuthUser, targetId: string): Promise<void> {
    const [result] = await this.db
      .delete(blocks)
      .where(and(eq(blocks.blockerId, user.userId), eq(blocks.blockedId, targetId)));
    if (result.affectedRows === 0) throw BlockErrors.notFound();
  }
}
