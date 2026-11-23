import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, or } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException, CommonErrors } from '../../common/errors/app-exception.js';
import { type Database, DB, type Transaction } from '../../infra/db/db.module.js';
import { friendRequests, friendships, users } from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { isBlockedBetween } from '../blocks/block-queries.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { toUserSummary } from '../users/user-summary.js';
import type { FriendRequestQuery } from './friends.schemas.js';

/** 친구 한도 (임시값) */
export const FRIEND_LIMIT = 100;

export const FriendErrors = {
  self: () =>
    new AppException(
      'FRIEND_SELF',
      '자기 자신에게는 친구 요청을 보낼 수 없습니다.',
      HttpStatus.BAD_REQUEST,
    ),
  // 차단 관계도 같은 문구로 답해 차단 사실을 드러내지 않는다
  notAllowed: () =>
    new AppException(
      'FRIEND_NOT_ALLOWED',
      '친구 요청을 보낼 수 없는 사용자입니다.',
      HttpStatus.FORBIDDEN,
    ),
  userNotFound: () =>
    new AppException('USER_NOT_FOUND', '사용자를 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
  already: () => new AppException('FRIEND_ALREADY', '이미 친구입니다.', HttpStatus.CONFLICT),
  duplicate: () =>
    new AppException(
      'FRIEND_REQUEST_DUPLICATE',
      '이미 친구 요청을 보냈습니다.',
      HttpStatus.CONFLICT,
    ),
  limit: () =>
    new AppException(
      'FRIEND_LIMIT_EXCEEDED',
      `친구는 ${FRIEND_LIMIT}명까지 맺을 수 있습니다.`,
      HttpStatus.CONFLICT,
    ),
  requestNotFound: () =>
    new AppException(
      'FRIEND_REQUEST_NOT_FOUND',
      '친구 요청을 찾을 수 없습니다.',
      HttpStatus.NOT_FOUND,
    ),
  notFound: () => new AppException('FRIEND_NOT_FOUND', '친구가 아닙니다.', HttpStatus.NOT_FOUND),
};

type Accepted = { requesterId: string; accepterId: string };

@Injectable()
export class FriendsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly notifications: NotificationsService,
  ) {}

  async list(user: AuthUser) {
    const rows = await this.db
      .select({ since: friendships.since, user: users })
      .from(friendships)
      .innerJoin(users, eq(users.id, friendships.friendId))
      .where(eq(friendships.userId, user.userId))
      .orderBy(desc(friendships.since), asc(users.name));
    return rows.map((row) => ({ user: toUserSummary(row.user), since: row.since.toISOString() }));
  }

  async requests(user: AuthUser, query: FriendRequestQuery) {
    const received = query.direction === 'RECEIVED';
    const rows = await this.db
      .select({ request: friendRequests, user: users })
      .from(friendRequests)
      .innerJoin(
        users,
        eq(users.id, received ? friendRequests.requesterId : friendRequests.receiverId),
      )
      .where(eq(received ? friendRequests.receiverId : friendRequests.requesterId, user.userId))
      .orderBy(desc(friendRequests.createdAt));
    return rows.map((row) => ({
      requestId: row.request.id,
      user: toUserSummary(row.user),
      createdAt: row.request.createdAt.toISOString(),
    }));
  }

  /**
   * 친구 요청. 상대가 이미 나에게 요청했으면 바로 친구가 된다(requestId null).
   * 두 사용자 행을 같은 순서로 잠가 서로 동시에 요청해도 한쪽만 처리되고 한도를 넘지 않게 한다
   */
  async request(user: AuthUser, targetId: string): Promise<{ requestId: string | null }> {
    if (targetId === user.userId) throw FriendErrors.self();
    const result = await this.db.transaction(async (tx) => {
      await this.lockUsers(tx, [user.userId, targetId]);
      const [target] = await tx
        .select({ role: users.role, status: users.status })
        .from(users)
        .where(eq(users.id, targetId));
      if (target?.status !== 'ACTIVE') throw FriendErrors.userNotFound();
      if (target.role !== 'STUDENT') throw FriendErrors.notAllowed();
      if (await isBlockedBetween(tx, user.userId, targetId)) throw FriendErrors.notAllowed();
      if (await this.areFriends(tx, user.userId, targetId)) throw FriendErrors.already();

      const [mine] = await tx
        .select({ id: friendRequests.id })
        .from(friendRequests)
        .where(this.requestBetween(user.userId, targetId));
      if (mine) throw FriendErrors.duplicate();
      await this.assertRoom(tx, [user.userId, targetId]);

      const [reverse] = await tx
        .select({ id: friendRequests.id })
        .from(friendRequests)
        .where(this.requestBetween(targetId, user.userId));
      // 취소는 사용자 잠금 없이 지우므로 실제로 지운 경우에만 친구가 된다
      if (reverse && (await this.deleteRequest(tx, reverse.id))) {
        await this.befriend(tx, user.userId, targetId);
        return { requestId: null, accepted: { requesterId: targetId, accepterId: user.userId } };
      }
      const requestId = newId();
      await tx
        .insert(friendRequests)
        .values({ id: requestId, requesterId: user.userId, receiverId: targetId });
      return { requestId, accepted: null };
    });

    if (result.accepted) {
      await this.notifyAccepted(result.accepted);
    } else {
      const name = await this.nameOf(user.userId);
      await this.notifications.notify([targetId], {
        type: 'FRIEND_REQUEST',
        title: '친구 요청',
        body: `${name}님이 친구 요청을 보냈어요.`,
        route: '/friends/requests',
      });
    }
    return { requestId: result.requestId };
  }

  /** 받은 요청만 수락할 수 있다. 양쪽 모두 한도를 확인한다 */
  async accept(user: AuthUser, requestId: string): Promise<void> {
    const request = await this.findRequest(this.db, requestId);
    if (request.receiverId !== user.userId) throw CommonErrors.forbidden();
    const accepted = await this.db.transaction(async (tx) => {
      // 잠금을 첫 문장으로 해야 뒤의 조회가 잠근 뒤의 최신 상태를 본다(취소·한도)
      await this.lockUsers(tx, [request.requesterId, request.receiverId]);
      if (!(await this.deleteRequest(tx, requestId))) throw FriendErrors.requestNotFound();
      const [requester] = await tx
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, request.requesterId));
      // 쓸 수 없는 계정의 요청은 지우기만 하고 404
      if (requester?.status !== 'ACTIVE') return null;
      if (!(await this.areFriends(tx, request.requesterId, request.receiverId))) {
        await this.assertRoom(tx, [request.requesterId, request.receiverId]);
        await this.befriend(tx, request.requesterId, request.receiverId);
      }
      return { requesterId: request.requesterId, accepterId: request.receiverId };
    });
    if (!accepted) throw FriendErrors.userNotFound();
    await this.notifyAccepted(accepted);
  }

  /** 받은 요청이면 거절, 보낸 요청이면 취소. 상대에게 알리지 않는다 */
  async removeRequest(user: AuthUser, requestId: string): Promise<void> {
    const request = await this.findRequest(this.db, requestId);
    if (request.requesterId !== user.userId && request.receiverId !== user.userId) {
      throw CommonErrors.forbidden();
    }
    await this.db.delete(friendRequests).where(eq(friendRequests.id, requestId));
  }

  /** 양쪽에서 함께 지운다 */
  async remove(user: AuthUser, friendId: string): Promise<void> {
    const [result] = await this.db
      .delete(friendships)
      .where(
        or(
          and(eq(friendships.userId, user.userId), eq(friendships.friendId, friendId)),
          and(eq(friendships.userId, friendId), eq(friendships.friendId, user.userId)),
        ),
      );
    if (result.affectedRows === 0) throw FriendErrors.notFound();
  }

  /** 차단할 때 두 사람의 친구 관계와 대기 중인 요청을 모두 지운다. 사용자 행은 호출하는 쪽이 잠근다 */
  async severInTx(tx: Transaction, a: string, b: string): Promise<void> {
    await tx
      .delete(friendships)
      .where(
        or(
          and(eq(friendships.userId, a), eq(friendships.friendId, b)),
          and(eq(friendships.userId, b), eq(friendships.friendId, a)),
        ),
      );
    await tx.delete(friendRequests).where(or(this.requestBetween(a, b), this.requestBetween(b, a)));
  }

  async lockUsers(tx: Transaction, ids: string[]): Promise<void> {
    await tx
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, ids))
      .orderBy(asc(users.id))
      .for('update');
  }

  private async findRequest(executor: Database | Transaction, requestId: string) {
    const [request] = await executor
      .select()
      .from(friendRequests)
      .where(eq(friendRequests.id, requestId));
    if (!request) throw FriendErrors.requestNotFound();
    return request;
  }

  private async deleteRequest(tx: Transaction, requestId: string): Promise<boolean> {
    const [result] = await tx.delete(friendRequests).where(eq(friendRequests.id, requestId));
    return result.affectedRows > 0;
  }

  private requestBetween(requesterId: string, receiverId: string) {
    return and(
      eq(friendRequests.requesterId, requesterId),
      eq(friendRequests.receiverId, receiverId),
    );
  }

  private async areFriends(tx: Transaction, a: string, b: string): Promise<boolean> {
    const [row] = await tx
      .select({ userId: friendships.userId })
      .from(friendships)
      .where(and(eq(friendships.userId, a), eq(friendships.friendId, b)));
    return Boolean(row);
  }

  private async assertRoom(tx: Transaction, ids: string[]): Promise<void> {
    const rows = await tx
      .select({ userId: friendships.userId, total: count() })
      .from(friendships)
      .where(inArray(friendships.userId, ids))
      .groupBy(friendships.userId);
    if (rows.some((row) => row.total >= FRIEND_LIMIT)) throw FriendErrors.limit();
  }

  private async befriend(tx: Transaction, a: string, b: string): Promise<void> {
    const since = new Date();
    await tx.insert(friendships).values([
      { userId: a, friendId: b, since },
      { userId: b, friendId: a, since },
    ]);
  }

  private async notifyAccepted({ requesterId, accepterId }: Accepted): Promise<void> {
    const name = await this.nameOf(accepterId);
    await this.notifications.notify([requesterId], {
      type: 'FRIEND_ACCEPTED',
      title: '친구 수락',
      body: `${name}님과 친구가 되었어요.`,
      route: `/users/${accepterId}`,
    });
  }

  private async nameOf(userId: string): Promise<string> {
    const [row] = await this.db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, userId));
    return row?.name ?? '';
  }
}
