import { z } from 'zod';
import { REPORT_REASON, REPORT_RESULT, REPORT_STATUS, REPORT_TARGET } from '../../common/enums.js';
import { PageQuery, page } from '../../common/pagination.js';
import { SanctionItem } from './admin-sanctions.schemas.js';

export const AdminReportQuery = PageQuery.extend({
  status: z.enum(REPORT_STATUS).optional(),
  reason: z.enum(REPORT_REASON).optional().describe('이 사유가 들어 있는 묶음'),
  from: z.iso.date().optional().describe('마지막 신고 KST 날짜, 포함'),
  to: z.iso.date().optional().describe('마지막 신고 KST 날짜, 포함'),
}).refine((q) => !q.from || !q.to || q.from <= q.to, {
  message: '시작 날짜가 끝 날짜보다 늦습니다.',
  path: ['from'],
});
export type AdminReportQuery = z.infer<typeof AdminReportQuery>;

export const AdminReportGroup = z
  .object({
    reportGroupId: z.string(),
    targetType: z.enum(REPORT_TARGET),
    target: z.object({
      id: z.string(),
      label: z.string().describe('사용자 이름·단어팩 이름·단어'),
    }),
    reasons: z.array(z.enum(REPORT_REASON)),
    reportCount: z.number().int(),
    status: z.enum(REPORT_STATUS),
    lastReportedAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminReportGroup' });
export type AdminReportGroup = z.infer<typeof AdminReportGroup>;
export const AdminReportGroupPage = page(AdminReportGroup).meta({ id: 'AdminReportGroupPage' });

const ResultView = z.object({
  result: z.enum(REPORT_RESULT),
  memo: z.string(),
  adminName: z.string().nullable(),
  resolvedAt: z.iso.datetime(),
});

export const AdminReportGroupDetail = AdminReportGroup.extend({
  reports: z
    .array(
      z.object({
        reportId: z.string(),
        reason: z.enum(REPORT_REASON),
        detail: z.string().nullable(),
        battleId: z.string().nullable(),
        createdAt: z.iso.datetime(),
      }),
    )
    .describe('신고한 사람은 보여 주지 않음'),
  targetHistory: z.object({
    reportCount: z.number().int().describe('이 대상이 받은 신고 전체 (지난 묶음 포함)'),
    sanctions: z.array(SanctionItem).describe('대상이 사용자일 때 제재 이력'),
  }),
  result: ResultView.nullable(),
  history: z
    .array(
      z.object({
        status: z.enum(REPORT_STATUS),
        result: z.enum(REPORT_RESULT).nullable(),
        memo: z.string().nullable(),
        adminName: z.string().nullable(),
        createdAt: z.iso.datetime(),
      }),
    )
    .describe('처리 변경 이력, 오래된 순'),
}).meta({ id: 'AdminReportGroupDetail' });
export type AdminReportGroupDetail = z.infer<typeof AdminReportGroupDetail>;

export const UpdateReportGroup = z
  .object({
    status: z.enum(REPORT_STATUS),
    result: z.enum(REPORT_RESULT).nullish(),
    memo: z.string().trim().min(1).max(1000).nullish(),
  })
  .superRefine((body, ctx) => {
    if (body.status === 'RESOLVED' && (!body.result || !body.memo)) {
      ctx.addIssue({
        code: 'custom',
        path: ['result'],
        message: '처리 완료에는 결과와 메모가 필요합니다.',
      });
    }
    if (body.status !== 'RESOLVED' && body.result) {
      ctx.addIssue({ code: 'custom', path: ['result'], message: '결과는 처리 완료에만 씁니다.' });
    }
  })
  .meta({ id: 'UpdateReportGroup' });
export type UpdateReportGroup = z.infer<typeof UpdateReportGroup>;
