import { describe, expect, it } from 'vitest';
import {
  type ProfileTarget,
  requestDirection,
  toSearchSummary,
  toUserProfile,
} from './user-directory-rules.js';
import { WITHDRAWN_USER_NAME } from './user-summary.js';

const target: ProfileTarget = {
  id: 'target',
  name: '홍길동',
  role: 'STUDENT',
  status: 'ACTIVE',
  grade: 2,
  classNo: 3,
  avatarId: 'cat',
  rankingPublic: true,
  totalXp: 120,
};
const relation = { isFriend: true, friendRequest: null, isBlocked: false };

describe('requestDirection', () => {
  it('내가 보냈으면 SENT, 받았으면 RECEIVED, 없으면 null', () => {
    expect(requestDirection('me', { requesterId: 'me', receiverId: 'x' })).toBe('SENT');
    expect(requestDirection('me', { requesterId: 'x', receiverId: 'me' })).toBe('RECEIVED');
    expect(requestDirection('me', undefined)).toBeNull();
  });
});

describe('toUserProfile', () => {
  it('공개 학생은 레벨·티어를 보여준다', () => {
    expect(toUserProfile('me', target, relation)).toEqual({
      user: {
        userId: 'target',
        name: '홍길동',
        grade: 2,
        classNo: 3,
        avatarId: 'cat',
        tier: 'BRONZE',
      },
      isMe: false,
      isPublic: true,
      level: 1,
      tier: 'BRONZE',
      representativeBadge: null,
      relation,
    });
  });

  it('랭킹 비공개면 남에게는 레벨·티어가 null', () => {
    const profile = toUserProfile('me', { ...target, rankingPublic: false }, relation);
    expect(profile).toMatchObject({ isPublic: false, level: null, tier: null });
    expect(profile.user.tier).toBeNull();
  });

  it('비공개여도 내 프로필은 레벨·티어를 보여준다', () => {
    const profile = toUserProfile('target', { ...target, rankingPublic: false }, relation);
    expect(profile).toMatchObject({ isMe: true, isPublic: false, level: 1, tier: 'BRONZE' });
  });

  it('정지·휴면 계정은 랭킹처럼 비공개로 친다', () => {
    for (const status of ['SUSPENDED', 'INACTIVE'] as const) {
      expect(toUserProfile('me', { ...target, status }, relation)).toMatchObject({
        isPublic: false,
        level: null,
        tier: null,
      });
    }
  });

  it('교사는 레벨·티어가 없고 비공개로 표시한다', () => {
    const profile = toUserProfile(
      'me',
      { ...target, role: 'TEACHER', grade: null, classNo: null },
      relation,
    );
    expect(profile).toMatchObject({ isPublic: false, level: null, tier: null });
  });

  it('탈퇴한 사용자는 이름만 바꾸고 나머지는 비운다', () => {
    const profile = toUserProfile('me', { ...target, status: 'WITHDRAWN' }, relation);
    expect(profile).toMatchObject({
      user: { name: WITHDRAWN_USER_NAME, grade: null, classNo: null, tier: null },
      isPublic: false,
      level: null,
      tier: null,
      representativeBadge: null,
    });
  });
});

describe('toUserProfile 대표 배지', () => {
  const badge = { badgeId: 'b1', name: '첫 학습', imageUrl: 'badges/first' };

  it('공개 프로필과 내 프로필에만 보인다', () => {
    expect(toUserProfile('me', target, relation, badge).representativeBadge).toEqual(badge);
    const hidden = { ...target, rankingPublic: false };
    expect(toUserProfile('me', hidden, relation, badge).representativeBadge).toBeNull();
    expect(toUserProfile('target', hidden, relation, badge).representativeBadge).toEqual(badge);
    expect(
      toUserProfile('me', { ...target, status: 'WITHDRAWN' }, relation, badge).representativeBadge,
    ).toBeNull();
  });
});

describe('toSearchSummary', () => {
  it('랭킹 비공개면 티어를 숨긴다', () => {
    expect(toSearchSummary(target).tier).toBe('BRONZE');
    expect(toSearchSummary({ ...target, rankingPublic: false }).tier).toBeNull();
  });
});
