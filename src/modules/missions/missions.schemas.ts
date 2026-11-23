import { z } from 'zod';
import { MISSION_PERIOD, MISSION_STATUS } from '../../common/enums.js';
import { XpResult } from '../study/study.schemas.js';

export const MissionItem = z
  .object({
    missionId: z.string(),
    period: z.enum(MISSION_PERIOD),
    title: z.string(),
    progress: z.number().int(),
    target: z.number().int(),
    rewardXp: z.number().int(),
    status: z.enum(MISSION_STATUS).describe('목록은 이번 기간만이라 EXPIRED는 나오지 않음'),
    expiresAt: z.iso.datetime().describe('일일은 다음 날 00:00, 주간은 다음 월요일 00:00 (KST)'),
  })
  .meta({ id: 'Mission' });
export type MissionItem = z.infer<typeof MissionItem>;

export const MissionList = z
  .object({ daily: z.array(MissionItem), weekly: z.array(MissionItem) })
  .meta({ id: 'MissionList' });

export const MissionClaimResult = z.object({ xp: XpResult }).meta({ id: 'MissionClaimResult' });
