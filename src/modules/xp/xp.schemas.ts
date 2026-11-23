import { z } from 'zod';
import { XP_BLOCK_REASON, XP_SOURCE } from '../../common/enums.js';
import { cursorPage } from '../../common/pagination.js';

export const XpHistoryItem = z
  .object({
    xpLogId: z.string(),
    source: z.enum(XP_SOURCE),
    title: z.string().describe('활동 이름'),
    amount: z.number().int().describe('음수면 관리자 조정·회수'),
    blockedReason: z
      .enum(XP_BLOCK_REASON)
      .nullable()
      .describe('하루 상한 등으로 덜 받았거나 못 받았을 때'),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'XpHistoryItem' });
export type XpHistoryItem = z.infer<typeof XpHistoryItem>;

export const XpHistoryPage = cursorPage(XpHistoryItem).meta({ id: 'XpHistoryPage' });
