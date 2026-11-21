import { z } from 'zod';
import { RANK_PERIOD, RANK_SCOPE } from '../../common/enums.js';
import { CursorQuery, cursorPage } from '../../common/pagination.js';
import { UserSummary } from '../users/user-summary.js';

const scopeQuery = {
  period: z.enum(RANK_PERIOD).default('WEEKLY'),
  scope: z.enum(RANK_SCOPE).default('SCHOOL').describe('GRADE·CLASS는 내 학년·반 기준'),
};

export const RankingQuery = CursorQuery.extend(scopeQuery);
export type RankingQuery = z.infer<typeof RankingQuery>;

export const MyRankingQuery = z.object(scopeQuery);
export type MyRankingQuery = z.infer<typeof MyRankingQuery>;

export const RankingEntry = z
  .object({ rank: z.number().int(), user: UserSummary, xp: z.number().int() })
  .meta({ id: 'RankingEntry' });
export type RankingEntry = z.infer<typeof RankingEntry>;

export const RankingPage = cursorPage(RankingEntry)
  .extend({
    available: z.boolean().describe('반 랭킹 참여 인원이 3명 미만이면 false'),
    updatedAt: z.iso.datetime().describe('목록을 마지막으로 계산한 시각 (5분마다)'),
  })
  .meta({ id: 'RankingPage' });
export type RankingPage = z.infer<typeof RankingPage>;

export const MyRanking = z
  .object({
    rank: z.number().int().nullable().describe('100위 밖이거나 XP가 0이면 null'),
    topPercent: z.number().int().nullable().describe('100위 밖일 때 상위 N%'),
    xp: z.number().int(),
    gapToNext: z.number().int().nullable().describe('바로 위 사람과의 XP 차이'),
    change: z
      .number()
      .int()
      .nullable()
      .describe('지난 기간 대비 순위 변동 (양수면 상승). 지난 기록이 없으면 null'),
    rankingPublic: z.boolean(),
  })
  .meta({ id: 'MyRanking' });
export type MyRanking = z.infer<typeof MyRanking>;
