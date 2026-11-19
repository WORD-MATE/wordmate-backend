import { describe, expect, it } from 'vitest';
import { toUserSummary, WITHDRAWN_USER_NAME } from './user-summary.js';

const base = {
  id: 'u1',
  name: '홍길동',
  role: 'STUDENT' as const,
  status: 'ACTIVE' as const,
  grade: 2,
  classNo: 3,
  avatarId: 'cat',
};

describe('toUserSummary', () => {
  it('학생은 학년·반·티어를 보여준다', () => {
    expect(toUserSummary(base)).toEqual({
      userId: 'u1',
      name: '홍길동',
      grade: 2,
      classNo: 3,
      avatarId: 'cat',
      tier: 'BRONZE',
    });
  });

  it('교사는 학년·반·티어가 null', () => {
    expect(toUserSummary({ ...base, role: 'TEACHER' })).toMatchObject({
      grade: null,
      classNo: null,
      tier: null,
    });
  });

  it('탈퇴 사용자는 이름과 정보를 숨긴다', () => {
    expect(toUserSummary({ ...base, status: 'WITHDRAWN' })).toMatchObject({
      name: WITHDRAWN_USER_NAME,
      grade: null,
      avatarId: 'default',
      tier: null,
    });
  });
});
