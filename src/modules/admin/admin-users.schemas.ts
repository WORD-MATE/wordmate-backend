import { z } from 'zod';
import { ACCOUNT_STATUS, ROLE } from '../../common/enums.js';
import { PageQuery, page } from '../../common/pagination.js';
import { ClassSummary, LevelInfo } from '../users/me.schema.js';
import { UserSummary } from '../users/user-summary.js';

const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

export const AdminUserQuery = PageQuery.extend({
  q: z.string().trim().min(1).max(50).optional().describe('학번(앞부분) 또는 이름(포함)'),
  role: z.enum(ROLE).optional(),
  isAdmin: flag.optional(),
  status: z.enum(ACCOUNT_STATUS).optional(),
});
export type AdminUserQuery = z.infer<typeof AdminUserQuery>;

export const AdminUserItem = z
  .object({
    user: UserSummary,
    studentNumber: z.string().nullable(),
    number: z.number().int().nullable(),
    role: z.enum(ROLE),
    isAdmin: z.boolean(),
    status: z.enum(ACCOUNT_STATUS),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminUser' });
export type AdminUserItem = z.infer<typeof AdminUserItem>;
export const AdminUserPage = page(AdminUserItem).meta({ id: 'AdminUserPage' });

export const AdminUserDetail = AdminUserItem.extend({
  suspendedUntil: z.iso.datetime().nullable(),
  teacherClasses: z.array(ClassSummary),
  level: LevelInfo,
  studySummary: z.object({
    solvedCount: z.number().int(),
    accuracy: z.number().nullable().describe('0~100, 소수 첫째 자리'),
    lastStudiedAt: z.iso.datetime().nullable(),
  }),
  battleSummary: z.object({
    total: z.number().int(),
    winCount: z.number().int(),
    leftCount: z.number().int(),
  }),
  reportCount: z.number().int().describe('받은 신고 수'),
}).meta({ id: 'AdminUserDetail' });
export type AdminUserDetail = z.infer<typeof AdminUserDetail>;

export const SetAdmin = z.object({ isAdmin: z.boolean() }).meta({ id: 'SetAdmin' });
export const SetUserClasses = z
  .object({ classIds: z.array(z.uuid()).min(1).max(20) })
  .meta({ id: 'SetUserClasses' });

export const XpAdjustment = z
  .object({
    delta: z
      .number()
      .int()
      .min(-100_000)
      .max(100_000)
      .refine((value) => value !== 0, '0은 조정할 수 없습니다.')
      .describe('양수 적립, 음수 차감'),
    reason: z.string().trim().min(1).max(200),
  })
  .meta({ id: 'XpAdjustment' });
export type XpAdjustment = z.infer<typeof XpAdjustment>;

export const XpAdjustmentResult = z
  .object({ totalXp: z.number().int(), level: z.number().int() })
  .meta({ id: 'XpAdjustmentResult' });
