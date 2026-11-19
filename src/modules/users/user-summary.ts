import { z } from 'zod';
import type { User } from '../../infra/db/schema/users.js';

export const UserSummary = z
  .object({
    userId: z.string(),
    name: z.string().describe('탈퇴 시 "탈퇴한 사용자"'),
    grade: z.number().int().nullable().describe('교사·탈퇴 사용자는 null'),
    classNo: z.number().int().nullable(),
    avatarId: z.string(),
    tier: z.string().nullable(),
  })
  .meta({ id: 'UserSummary' });
export type UserSummary = z.infer<typeof UserSummary>;

export const WITHDRAWN_USER_NAME = '탈퇴한 사용자';

export function toUserSummary(
  user: Pick<User, 'id' | 'name' | 'role' | 'status' | 'grade' | 'classNo' | 'avatarId'>,
): UserSummary {
  const withdrawn = user.status === 'WITHDRAWN';
  const student = user.role === 'STUDENT' && !withdrawn;
  return {
    userId: user.id,
    name: withdrawn ? WITHDRAWN_USER_NAME : user.name,
    grade: student ? user.grade : null,
    classNo: student ? user.classNo : null,
    avatarId: withdrawn ? 'default' : user.avatarId,
    // 레벨·티어 규칙이 확정되기 전까지 학생은 모두 BRONZE (Me와 같음)
    tier: student ? 'BRONZE' : null,
  };
}
