import { z } from 'zod';
import { REPORT_REASON, REPORT_TARGET } from '../../common/enums.js';

export const REPORT_DETAIL_MAX = 200;

export const CreateReport = z
  .object({
    targetType: z.enum(REPORT_TARGET),
    targetId: z.uuid(),
    reason: z.enum(REPORT_REASON),
    detail: z.string().trim().max(REPORT_DETAIL_MAX).optional().describe('OTHER면 필수'),
    battleId: z.uuid().optional().describe('대결 중 일어난 일이면 그 대결'),
  })
  .refine((body) => body.reason !== 'OTHER' || Boolean(body.detail), {
    message: '기타 사유는 상세 내용을 적어야 합니다.',
    path: ['detail'],
  })
  .meta({ id: 'CreateReport' });
export type CreateReport = z.infer<typeof CreateReport>;

export const ReportCreated = z.object({ reportId: z.string() }).meta({ id: 'ReportCreated' });
