import { z } from 'zod';
import { STUDY_SOURCE } from '../../common/enums.js';
import { PackSummary } from '../packs/packs.schemas.js';

export const Home = z
  .object({
    morning: z
      .object({
        date: z.string(),
        sentence: z.string(),
        translation: z.string(),
        keywords: z.array(z.string()),
        completed: z.boolean(),
        isFallback: z.boolean(),
      })
      .nullable()
      .describe('게시된 문장이 하나도 없으면 null'),
    review: z.object({ dueCount: z.number().int() }).nullable(),
    continueStudy: z
      .object({
        sessionId: z.string(),
        source: z.enum(STUDY_SOURCE),
        packId: z.string().nullable(),
        packName: z.string().describe('팩 학습이 아니면 "즐겨찾기"처럼 학습 종류 이름'),
        answered: z.number().int(),
        total: z.number().int(),
      })
      .nullable()
      .describe('이어할 학습이 없으면 null'),
    streak: z
      .object({ current: z.number().int(), best: z.number().int(), todayDone: z.boolean() })
      .nullable(),
    missions: z
      .array(
        z.object({
          missionId: z.string(),
          title: z.string(),
          progress: z.number().int(),
          target: z.number().int(),
          status: z.string(),
        }),
      )
      .nullable()
      .describe('미션 기능 전까지 null'),
    myWeeklyRank: z
      .object({
        rank: z.number().int().nullable(),
        topPercent: z.number().int().nullable(),
        xp: z.number().int(),
        change: z.number().int().nullable(),
      })
      .nullable()
      .describe('학교 범위 주간 순위. 교사는 null'),
    recommendedPacks: z
      .array(PackSummary)
      .describe('학습 기록이 없는 사용자에게만 기본 단어팩 추천순, 나머지는 빈 배열'),
  })
  .meta({ id: 'Home' });
export type Home = z.infer<typeof Home>;
