import type { NewUser, User } from '../../infra/db/schema/index.js';
import { WITHDRAWN_USER_NAME } from '../users/user-summary.js';

/** 정지가 아직 남았는지 (종료일이 없으면 영구 정지) */
export const suspensionActive = (until: Date | null, now: Date): boolean =>
  until === null || until > now;

export type WithdrawnSuspension = {
  datagsmId: string;
  suspendedUntil: Date | null;
  reason: string;
};

/** 정지 중에 탈퇴하면 따로 남길 정지 정보. 정지가 아니거나 이미 끝났으면 null */
export function withdrawnSuspensionOf(
  user: Pick<User, 'status' | 'datagsmId' | 'suspendedUntil' | 'suspendReason'>,
  now: Date,
): WithdrawnSuspension | null {
  if (user.status !== 'SUSPENDED' || !user.datagsmId) return null;
  if (!suspensionActive(user.suspendedUntil, now)) return null;
  return {
    datagsmId: user.datagsmId,
    suspendedUntil: user.suspendedUntil,
    reason: user.suspendReason ?? '',
  };
}

/** 이 사용자가 빠지면 활동 중인 관리자가 하나도 남지 않는지 (정지·휴면 관리자는 관리할 수 없음) */
export const isLastActiveAdmin = (admins: Pick<User, 'id' | 'status'>[], userId: string): boolean =>
  admins.filter((a) => a.status === 'ACTIVE').every((a) => a.id === userId);

/**
 * 탈퇴한 사용자 행. 끝난 대결 결과처럼 다른 사람이 보는 기록이 이 행을 참조하므로 지우지 않고 비운다.
 * 이름은 NOT NULL이라 표시용 문구로 덮는다
 */
export const anonymizedUser = (now: Date) =>
  ({
    status: 'WITHDRAWN',
    withdrawnAt: now,
    name: WITHDRAWN_USER_NAME,
    datagsmId: null,
    datagsmStudentId: null,
    email: null,
    studentNumber: null,
    grade: null,
    classNo: null,
    number: null,
    avatarId: 'default',
    isAdmin: false,
    rankingPublic: false,
    rankingOnboarded: false,
    totalXp: 0,
    suspendedUntil: null,
    suspendReason: null,
    lastLoginAt: null,
  }) satisfies Partial<NewUser>;
