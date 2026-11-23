import type { User } from '../../infra/db/schema/users.js';
import { levelOf } from './me.schema.js';
import type { RepresentativeBadge, UserProfile, UserRelation } from './user-directory.schemas.js';
import { toUserSummary, type UserSummary } from './user-summary.js';

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
  badge: RepresentativeBadge | null = null,
): UserProfile {
  const isMe = target.id === viewerId;
  const summary = toUserSummary(target);
  const student = target.role === 'STUDENT' && target.status !== 'WITHDRAWN';
  // 랭킹과 같게 정지·휴면 계정은 공개로 치지 않는다
  const isPublic = student && target.status === 'ACTIVE' && target.rankingPublic;
  const visible = student && (isPublic || isMe);
  const level = visible ? levelOf(target.totalXp) : null;
  return {
    user: { ...summary, tier: level?.tier ?? null },
    isMe,
    isPublic,
    level: level?.level ?? null,
    tier: level?.tier ?? null,
    // 배지 목록처럼 랭킹 비공개면 남에게 배지를 보이지 않는다
    representativeBadge: visible ? badge : null,
    relation,
  };
}

/** 검색 결과용. 랭킹 비공개면 티어를 숨긴다 */
export function toSearchSummary(target: Omit<ProfileTarget, 'totalXp'>): UserSummary {
  const summary = toUserSummary(target);
  return target.rankingPublic ? summary : { ...summary, tier: null };
}
