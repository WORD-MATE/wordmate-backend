import type { User } from '../../infra/db/schema/users.js';
import { levelOf } from './me.schema.js';
import type { UserProfile, UserRelation } from './user-directory.schemas.js';
import { toUserSummary } from './user-summary.js';

type FriendRequestPair = { requesterId: string; receiverId: string };

/** 나와 상대 사이의 대기 중인 요청을 내 기준 방향으로 바꾼다 */
export function requestDirection(
  viewerId: string,
  request: FriendRequestPair | undefined,
): 'RECEIVED' | 'SENT' | null {
  if (!request) return null;
  return request.requesterId === viewerId ? 'SENT' : 'RECEIVED';
}

export type ProfileTarget = Pick<
  User,
  'id' | 'name' | 'role' | 'status' | 'grade' | 'classNo' | 'avatarId' | 'rankingPublic' | 'totalXp'
>;

export function toUserProfile(
  viewerId: string,
  target: ProfileTarget,
  relation: UserRelation,
): UserProfile {
  const isMe = target.id === viewerId;
  const summary = toUserSummary(target);
  const student = target.role === 'STUDENT' && target.status !== 'WITHDRAWN';
  const isPublic = student && target.rankingPublic;
  const visible = student && (isPublic || isMe);
  const level = visible ? levelOf(target.totalXp) : null;
  return {
    user: { ...summary, tier: level?.tier ?? null },
    isMe,
    isPublic,
    level: level?.level ?? null,
    tier: level?.tier ?? null,
    // 대표 배지 지정 기능이 들어오면 채운다
    representativeBadge: null,
    relation,
  };
}
