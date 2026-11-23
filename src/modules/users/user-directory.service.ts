import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, like, ne, notExists, or } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException } from '../../common/errors/app-exception.js';
import { type CursorPage, decodeCursor, toCursorPage } from '../../common/pagination.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import {
  badges,
  blocks,
  friendRequests,
  friendships,
  userBadges,
  users,
} from '../../infra/db/schema/index.js';
import { blockersAmong } from '../blocks/block-queries.js';
import type {
  RepresentativeBadge,
  UserProfile,
  UserRelation,
  UserSearchItem,
  UserSearchQuery,
} from './user-directory.schemas.js';
import { requestDirection, toSearchSummary, toUserProfile } from './user-directory-rules.js';

export const UserDirectoryErrors = {
  userNotFound: () =>
    new AppException('USER_NOT_FOUND', '사용자를 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
};

const SearchCursor = z.object({ name: z.string(), id: z.uuid() });

@Injectable()
export class UserDirectoryService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** 친구 추가용. 쓸 수 있는 학생 계정만 이름순으로 찾는다 */
  async search(viewer: AuthUser, query: UserSearchQuery): Promise<CursorPage<UserSearchItem>> {
    const keyword = query.q.replace(/[%_\\]/g, (c) => `\\${c}`);
    const cursor = query.cursor ? decodeCursor(query.cursor, SearchCursor) : null;
    const rows = await this.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.role, 'STUDENT'),
          eq(users.status, 'ACTIVE'),
          ne(users.id, viewer.userId),
          or(like(users.name, `%${keyword}%`), like(users.studentNumber, `${keyword}%`)),
          notExists(
            this.db
              .select({ one: blocks.blockerId })
              .from(blocks)
              .where(and(eq(blocks.blockerId, users.id), eq(blocks.blockedId, viewer.userId))),
          ),
          cursor
            ? or(
                gt(users.name, cursor.name),
                and(eq(users.name, cursor.name), gt(users.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(asc(users.name), asc(users.id))
      .limit(query.size + 1);
    const page = toCursorPage(rows, query.size, (last) => ({ name: last.name, id: last.id }));

    const ids = page.items.map((row) => row.id);
    const [friends, requests] = await Promise.all([
      this.friendsAmong(viewer.userId, ids),
      this.requestsAmong(viewer.userId, ids),
    ]);
    return {
      nextCursor: page.nextCursor,
      items: page.items.map((row) => ({
        user: toSearchSummary(row),
        isFriend: friends.has(row.id),
        friendRequest: requestDirection(viewer.userId, requests.get(row.id)),
      })),
    };
  }

  /** 나를 차단한 사용자는 없는 사용자처럼 404로 답한다 */
  async profile(viewer: AuthUser, userId: string): Promise<UserProfile> {
    const [target] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!target) throw UserDirectoryErrors.userNotFound();
    if (target.id === viewer.userId) {
      return toUserProfile(
        viewer.userId,
        target,
        { isFriend: false, friendRequest: null, isBlocked: false },
        await this.representativeBadge(target.id, target.representativeBadgeId),
      );
    }
    const ids = [target.id];
    const [blockedMe, friends, requests, blockedByMe, badge] = await Promise.all([
      blockersAmong(this.db, viewer.userId, ids),
      this.friendsAmong(viewer.userId, ids),
      this.requestsAmong(viewer.userId, ids),
      this.blockedAmong(viewer.userId, ids),
      this.representativeBadge(target.id, target.representativeBadgeId),
    ]);
    if (blockedMe.has(target.id)) throw UserDirectoryErrors.userNotFound();
    const relation: UserRelation = {
      isFriend: friends.has(target.id),
      friendRequest: requestDirection(viewer.userId, requests.get(target.id)),
      isBlocked: blockedByMe.has(target.id),
    };
    return toUserProfile(viewer.userId, target, relation, badge);
  }

  /** 숨긴 배지나 더는 갖고 있지 않은 배지는 보이지 않는다 */
  private async representativeBadge(
    userId: string,
    badgeId: string | null,
  ): Promise<RepresentativeBadge | null> {
    if (!badgeId) return null;
    const [row] = await this.db
      .select({ badgeId: badges.id, name: badges.name, imageUrl: badges.imageUrl })
      .from(userBadges)
      .innerJoin(badges, eq(badges.id, userBadges.badgeId))
      .where(
        and(
          eq(userBadges.userId, userId),
          eq(userBadges.badgeId, badgeId),
          eq(badges.active, true),
        ),
      );
    return row ?? null;
  }

  private async friendsAmong(viewerId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.db
      .select({ friendId: friendships.friendId })
      .from(friendships)
      .where(and(eq(friendships.userId, viewerId), inArray(friendships.friendId, ids)));
    return new Set(rows.map((row) => row.friendId));
  }

  private async requestsAmong(viewerId: string, ids: string[]) {
    const result = new Map<string, { requesterId: string; receiverId: string }>();
    if (ids.length === 0) return result;
    const rows = await this.db
      .select({ requesterId: friendRequests.requesterId, receiverId: friendRequests.receiverId })
      .from(friendRequests)
      .where(
        or(
          and(eq(friendRequests.requesterId, viewerId), inArray(friendRequests.receiverId, ids)),
          and(eq(friendRequests.receiverId, viewerId), inArray(friendRequests.requesterId, ids)),
        ),
      );
    for (const row of rows) {
      const other = row.requesterId === viewerId ? row.receiverId : row.requesterId;
      // 양쪽 요청이 함께 있을 수는 없지만(먼저 온 요청을 수락함) 있으면 받은 요청을 앞세운다
      if (!result.has(other) || row.receiverId === viewerId) result.set(other, row);
    }
    return result;
  }

  private async blockedAmong(viewerId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.db
      .select({ blockedId: blocks.blockedId })
      .from(blocks)
      .where(and(eq(blocks.blockerId, viewerId), inArray(blocks.blockedId, ids)));
    return new Set(rows.map((row) => row.blockedId));
  }
}
