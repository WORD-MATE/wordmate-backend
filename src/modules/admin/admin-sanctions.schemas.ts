import { z } from 'zod';
import { SANCTION_TYPE } from '../../common/enums.js';

const reason = z.string().trim().min(1).max(200).describe('사용자에게 안내됨');
const future = z.iso
  .datetime()
  .refine((value) => new Date(value).getTime() > Date.now(), '지난 시각으로 정지할 수 없습니다.');

export const ApplySanction = z
  .object({
    userId: z.uuid(),
    type: z.enum(SANCTION_TYPE),
    reason,
    suspendedUntil: future.optional().describe('SUSPEND만, 필수'),
    revokeXp: z.number().int().min(1).max(100_000).optional().describe('XP_REVOKE만, 필수'),
    excludeFromSeason: z.boolean().optional().describe('이번 시즌 순위에서 제외'),
    reportGroupId: z.string().min(1).max(100).optional().describe('처리한 신고 묶음'),
  })
  .superRefine((body, ctx) => {
    if (body.type === 'SUSPEND' && !body.suspendedUntil) {
      ctx.addIssue({
        code: 'custom',
        path: ['suspendedUntil'],
        message: '정지 기간이 필요합니다.',
      });
    }
    if (body.type !== 'SUSPEND' && body.suspendedUntil) {
      ctx.addIssue({ code: 'custom', path: ['suspendedUntil'], message: '정지에만 씁니다.' });
    }
    if (body.type === 'XP_REVOKE' && !body.revokeXp) {
      ctx.addIssue({ code: 'custom', path: ['revokeXp'], message: '회수할 XP가 필요합니다.' });
    }
    if (body.type !== 'XP_REVOKE' && body.revokeXp) {
      ctx.addIssue({ code: 'custom', path: ['revokeXp'], message: 'XP 회수에만 씁니다.' });
    }
  })
  .meta({ id: 'ApplySanction' });
export type ApplySanction = z.infer<typeof ApplySanction>;

export const SanctionCreated = z.object({ sanctionId: z.string() }).meta({ id: 'SanctionCreated' });

/** 정지는 제재와 같은 처리, 해제는 정지만 푼다 */
export const SetUserStatus = z
  .object({
    status: z.enum(['ACTIVE', 'SUSPENDED']),
    reason,
    suspendedUntil: future.nullish().describe('SUSPENDED일 때, 없으면 영구'),
  })
  .meta({ id: 'SetUserStatus' });

export const SanctionItem = z
  .object({
    sanctionId: z.string(),
    type: z.enum(SANCTION_TYPE),
    reason: z.string(),
    until: z.iso.datetime().nullable(),
    revokedXp: z.number().int().nullable(),
    adminName: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Sanction' });
