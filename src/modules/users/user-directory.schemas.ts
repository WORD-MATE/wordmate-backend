import { z } from 'zod';
import { CursorQuery, cursorPage } from '../../common/pagination.js';
import { FRIEND_REQUEST_DIRECTION } from '../friends/friends.schemas.js';
import { UserSummary } from './user-summary.js';

export const UserSearchQuery = CursorQuery.extend({
  q: z.string().trim().min(1).max(50).describe('이름(포함) 또는 학번(앞부분)'),
});
export type UserSearchQuery = z.infer<typeof UserSearchQuery>;

const FriendRequestDirection = z
  .enum(FRIEND_REQUEST_DIRECTION)
  .nullable()
  .describe('대기 중인 친구 요청. RECEIVED는 상대가 나에게, SENT는 내가 상대에게 보낸 것');

export const UserSearchItem = z
  .object({ user: UserSummary, isFriend: z.boolean(), friendRequest: FriendRequestDirection })
  .meta({ id: 'UserSearchItem' });
export type UserSearchItem = z.infer<typeof UserSearchItem>;
export const UserSearchPage = cursorPage(UserSearchItem).meta({ id: 'UserSearchPage' });

export const UserRelation = z
  .object({
    isFriend: z.boolean(),
    friendRequest: FriendRequestDirection,
    isBlocked: z.boolean().describe('내가 차단했는지'),
  })
  .meta({ id: 'UserRelation' });
export type UserRelation = z.infer<typeof UserRelation>;

export const RepresentativeBadge = z
  .object({ badgeId: z.string(), name: z.string(), imageUrl: z.string() })
  .meta({ id: 'RepresentativeBadge' });

export const UserProfile = z
  .object({
    user: UserSummary,
    isMe: z.boolean(),
    isPublic: z.boolean().describe('랭킹 공개 여부. 교사·탈퇴한 사용자는 false'),
    level: z.number().int().nullable().describe('비공개·교사·탈퇴면 null (내 프로필은 항상 보임)'),
    tier: z.string().nullable(),
    representativeBadge: RepresentativeBadge.nullable(),
    relation: UserRelation,
  })
  .meta({ id: 'UserProfile' });
export type UserProfile = z.infer<typeof UserProfile>;
