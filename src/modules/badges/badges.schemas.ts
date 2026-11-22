import { z } from 'zod';
import { BADGE_TYPE } from '../../common/enums.js';

export const BadgeQuery = z.object({
  userId: z.uuid().optional().describe('없으면 나'),
});

export const BadgeItem = z
  .object({
    badgeId: z.string(),
    type: z.enum(BADGE_TYPE),
    name: z.string(),
    description: z.string(),
    condition: z.string().describe('얻는 방법 안내 문구'),
    imageUrl: z.string().describe('앱이 이미지 주소로 바꾸는 키'),
    earned: z.boolean(),
    earnedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Badge' });
export const BadgeList = z.array(BadgeItem).meta({ id: 'BadgeList' });
