import { z } from 'zod';
import { ROLE } from '../../common/enums.js';
import type { User } from '../../infra/db/schema/users.js';

export const ClassSummary = z
  .object({ classId: z.string(), grade: z.number().int(), classNo: z.number().int() })
  .meta({ id: 'ClassSummary' });

export const LevelInfo = z
  .object({
    level: z.number().int(),
    tier: z.string(),
    totalXp: z.number().int(),
    currentLevelXp: z.number().int(),
    nextLevelXp: z.number().int().nullable(),
  })
  .meta({ id: 'LevelInfo' });

export const Me = z
  .object({
    userId: z.string(),
    name: z.string(),
    studentNumber: z.string().nullable(),
    grade: z.number().int().nullable(),
    classNo: z.number().int().nullable(),
    number: z.number().int().nullable(),
    role: z.enum(ROLE),
    isAdmin: z.boolean(),
    avatarId: z.string(),
    representativeBadgeId: z.string().nullable(),
    rankingPublic: z.boolean(),
    rankingOnboarded: z.boolean(),
    level: LevelInfo,
    teacherClasses: z.array(ClassSummary),
  })
  .meta({ id: 'Me' });
export type Me = z.infer<typeof Me>;

// 레벨·티어 규칙이 확정되기 전까지 모든 사용자를 1레벨로 내려준다
const levelOf = (totalXp: number): z.infer<typeof LevelInfo> => ({
  level: 1,
  tier: 'BRONZE',
  totalXp,
  currentLevelXp: totalXp,
  nextLevelXp: null,
});

export type ClassSummary = z.infer<typeof ClassSummary>;

export function toMe(user: User, teacherClasses: ClassSummary[] = []): Me {
  return {
    userId: user.id,
    name: user.name,
    studentNumber: user.studentNumber,
    grade: user.grade,
    classNo: user.classNo,
    number: user.number,
    role: user.role,
    isAdmin: user.isAdmin,
    avatarId: user.avatarId,
    representativeBadgeId: null,
    rankingPublic: user.rankingPublic,
    rankingOnboarded: user.rankingOnboarded,
    level: levelOf(user.totalXp),
    teacherClasses,
  };
}
