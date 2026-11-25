import type { AccountStatus, SanctionType } from '../../common/enums.js';

/** 이미 더 길게(영구 포함) 정지돼 있으면 새 기간 정지로 줄이지 않는다 */
export function keepsLongerSuspension(
  current: { status: AccountStatus; suspendedUntil: Date | null },
  type: SanctionType,
  until: Date | null,
): boolean {
  if (type !== 'SUSPEND' || current.status !== 'SUSPENDED') return false;
  return current.suspendedUntil === null || (until !== null && current.suspendedUntil >= until);
}
