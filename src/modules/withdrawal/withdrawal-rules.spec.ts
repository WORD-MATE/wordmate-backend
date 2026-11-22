import { describe, expect, it } from 'vitest';
import { WITHDRAWN_USER_NAME } from '../users/user-summary.js';
import {
  anonymizedUser,
  isLastActiveAdmin,
  suspensionActive,
  withdrawnSuspensionOf,
} from './withdrawal-rules.js';

const now = new Date('2026-11-23T00:00:00Z');
const later = new Date('2026-11-30T00:00:00Z');
const earlier = new Date('2026-11-01T00:00:00Z');

describe('정지 기간', () => {
  it('종료일이 없으면 영구 정지라 계속 남아 있다', () => {
    expect(suspensionActive(null, now)).toBe(true);
  });

  it('종료일이 지나면 끝난다', () => {
    expect(suspensionActive(later, now)).toBe(true);
    expect(suspensionActive(now, now)).toBe(false);
    expect(suspensionActive(earlier, now)).toBe(false);
  });
});

describe('정지 중 탈퇴 보관 정보', () => {
  const suspended = {
    status: 'SUSPENDED' as const,
    datagsmId: 'dg-1',
    suspendedUntil: later,
    suspendReason: '욕설',
  };

  it('정지 중이면 DataGSM 식별값과 종료일을 남긴다', () => {
    expect(withdrawnSuspensionOf(suspended, now)).toEqual({
      datagsmId: 'dg-1',
      suspendedUntil: later,
      reason: '욕설',
    });
  });

  it('영구 정지는 종료일 없이 남긴다', () => {
    expect(withdrawnSuspensionOf({ ...suspended, suspendedUntil: null }, now)).toMatchObject({
      suspendedUntil: null,
    });
  });

  it('정지가 아니거나, 이미 끝났거나, DataGSM 연결이 없으면 남기지 않는다', () => {
    expect(withdrawnSuspensionOf({ ...suspended, status: 'ACTIVE' }, now)).toBeNull();
    expect(withdrawnSuspensionOf({ ...suspended, suspendedUntil: earlier }, now)).toBeNull();
    expect(withdrawnSuspensionOf({ ...suspended, datagsmId: null }, now)).toBeNull();
  });
});

describe('마지막 관리자', () => {
  it('활동 중인 다른 관리자가 없으면 마지막 관리자다', () => {
    expect(isLastActiveAdmin([{ id: 'a', status: 'ACTIVE' }], 'a')).toBe(true);
    expect(
      isLastActiveAdmin(
        [
          { id: 'a', status: 'ACTIVE' },
          { id: 'b', status: 'SUSPENDED' },
        ],
        'a',
      ),
    ).toBe(true);
  });

  it('활동 중인 다른 관리자가 있으면 아니다', () => {
    expect(
      isLastActiveAdmin(
        [
          { id: 'a', status: 'ACTIVE' },
          { id: 'b', status: 'ACTIVE' },
        ],
        'a',
      ),
    ).toBe(false);
  });
});

describe('익명화', () => {
  it('개인정보와 DataGSM 연결을 비우고 표시 이름만 남긴다', () => {
    expect(anonymizedUser(now)).toMatchObject({
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
      isAdmin: false,
      totalXp: 0,
    });
  });
});
