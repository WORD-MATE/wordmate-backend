import { z } from 'zod';
import { SEASON_PERIOD, SEASON_STATUS } from '../../common/enums.js';
import { PageQuery, page } from '../../common/pagination.js';
import { UserSummary } from '../users/user-summary.js';

export const AdminSeasonQuery = PageQuery.extend({
  period: z.enum(SEASON_PERIOD).optional(),
  status: z.enum(SEASON_STATUS).optional(),
});
export type AdminSeasonQuery = z.infer<typeof AdminSeasonQuery>;

export const AdminSeason = z
  .object({
    seasonId: z.string(),
    period: z.enum(SEASON_PERIOD),
    periodKey: z.string().describe('주간은 그 주 월요일, 월간은 YYYY-MM'),
    startDate: z.iso.date().describe('KST, 포함'),
    endDate: z.iso.date().describe('KST 마지막 날, 포함'),
    status: z.enum(SEASON_STATUS),
    pendingReportCount: z
      .number()
      .int()
      .describe('이 시즌 학교 순위에 든 사용자가 대상인 처리 전 신고 묶음 수 (지금 기준)'),
    closedAt: z.iso.datetime().nullable().describe('확정 시각'),
  })
  .meta({ id: 'AdminSeason' });
export type AdminSeason = z.infer<typeof AdminSeason>;
export const AdminSeasonPage = page(AdminSeason).meta({ id: 'AdminSeasonPage' });

export const AdminSeasonDetail = AdminSeason.extend({
  attempts: z.number().int().describe('마감 시도 횟수'),
  error: z.string().nullable().describe('FAILED일 때 마지막 실패 사유'),
  ranking: z
    .array(
      z.object({
        rank: z.number().int().nullable().describe('제외된 사용자는 null'),
        user: UserSummary,
        xp: z.number().int(),
        listed: z.boolean().describe('마감 시점에 랭킹 목록에 보였는지 (비공개 등은 false)'),
        excluded: z.boolean(),
      }),
    )
    .describe('학교 범위 상위 100위까지, 마감 순서. 그 사이의 제외된 사용자도 함께'),
  exclusions: z
    .array(
      z.object({
        user: UserSummary,
        reason: z.string(),
        adminName: z.string().nullable(),
        excludedAt: z.iso.datetime(),
      }),
    )
    .describe('제외된 사용자 전체'),
}).meta({ id: 'AdminSeasonDetail' });
export type AdminSeasonDetail = z.infer<typeof AdminSeasonDetail>;

export const UpdateSeasonExclusions = z
  .object({
    userIds: z.array(z.uuid()).max(100).describe('제외할 사용자 전체 (빈 배열이면 모두 해제)'),
    reason: z.string().trim().min(1).max(200),
  })
  .meta({ id: 'UpdateSeasonExclusions' });
export type UpdateSeasonExclusions = z.infer<typeof UpdateSeasonExclusions>;

export const SeasonRerunQueued = z
  .object({ seasonId: z.string(), queuedAt: z.iso.datetime() })
  .meta({ id: 'SeasonRerunQueued' });
