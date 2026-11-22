import { z } from 'zod';
import { SUSPICIOUS_REASON } from '../../common/enums.js';
import { PageQuery, page } from '../../common/pagination.js';
import { UserSummary } from '../users/user-summary.js';

const flag = z.enum(['true', 'false']).transform((value) => value === 'true');

export const AdminSuspiciousQuery = PageQuery.extend({
  reason: z.enum(SUSPICIOUS_REASON).optional().describe('이 사유가 들어 있는 항목'),
  reviewed: flag
    .optional()
    .describe('true면 모두 확인한 항목, false면 확인하지 않은 사유가 남은 항목'),
  from: z.iso.date().optional().describe('활동한 KST 날짜, 포함'),
  to: z.iso.date().optional().describe('활동한 KST 날짜, 포함'),
}).refine((q) => !q.from || !q.to || q.from <= q.to, {
  message: '시작 날짜가 끝 날짜보다 늦습니다.',
  path: ['from'],
});
export type AdminSuspiciousQuery = z.infer<typeof AdminSuspiciousQuery>;

export const AdminSuspiciousItem = z
  .object({
    user: UserSummary,
    date: z.iso.date().describe('활동한 날 (KST)'),
    reasons: z.array(z.enum(SUSPICIOUS_REASON)),
    detail: z
      .partialRecord(z.enum(SUSPICIOUS_REASON), z.record(z.string(), z.unknown()))
      .describe(
        '사유별 근거 수치. FAST_ANSWERS {answerCount, fastCount, fastRatio}, REPEATED_OPPONENT {opponents[{userId, battleCount}]}, XP_SPIKE {capDays, daily[{date, xp}]}',
      ),
    detectedAt: z.iso.datetime().describe('처음 감지한 시각'),
    reviewed: z.boolean().describe('모든 사유를 확인했는지'),
  })
  .meta({ id: 'AdminSuspiciousItem' });
export type AdminSuspiciousItem = z.infer<typeof AdminSuspiciousItem>;
export const AdminSuspiciousPage = page(AdminSuspiciousItem).meta({ id: 'AdminSuspiciousPage' });

export const ReviewSuspicious = z
  .object({ reviewed: z.boolean() })
  .meta({ id: 'ReviewSuspicious' });
export type ReviewSuspicious = z.infer<typeof ReviewSuspicious>;
