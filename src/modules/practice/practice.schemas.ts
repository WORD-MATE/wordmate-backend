import { z } from 'zod';
import {
  BATTLE_QUESTION_COUNTS,
  BATTLE_QUESTION_TYPES,
  BATTLE_TIME_LIMITS,
} from '../battles/battle.schemas.js';
import { CHOICE_COUNT } from '../study/question-builder.js';

export const StartPractice = z
  .object({
    packId: z.uuid().describe('기본 단어팩이나 내 단어팩, 단어 10개 이상'),
    questionType: z.enum(BATTLE_QUESTION_TYPES).describe('4지선다만'),
    questionCount: z.union(BATTLE_QUESTION_COUNTS.map((count) => z.literal(count))),
    timeLimitSec: z.union(BATTLE_TIME_LIMITS.map((seconds) => z.literal(seconds))),
  })
  .meta({ id: 'StartPractice' });
export type StartPractice = z.infer<typeof StartPractice>;

export const Practice = z
  .object({
    practiceId: z.string(),
    questions: z.array(
      z.object({
        index: z.number().int(),
        prompt: z.string(),
        choices: z.array(z.string()),
        answerIndex: z.number().int(),
      }),
    ),
  })
  .meta({ id: 'Practice' });
export type Practice = z.infer<typeof Practice>;

export const CompletePractice = z
  .object({
    answers: z
      .array(
        z.object({
          index: z.number().int().min(0),
          choiceIndex: z
            .number()
            .int()
            .min(0)
            .max(CHOICE_COUNT - 1)
            .nullable()
            .describe('미응답이면 null'),
          elapsedMs: z.number().int().min(0),
        }),
      )
      .max(Math.max(...BATTLE_QUESTION_COUNTS))
      .refine((answers) => new Set(answers.map((a) => a.index)).size === answers.length, {
        message: '같은 문항을 두 번 보낼 수 없습니다.',
      })
      .describe('보내지 않은 문항과 제한 시간을 넘긴 답은 미응답'),
  })
  .meta({ id: 'CompletePractice' });
export type CompletePractice = z.infer<typeof CompletePractice>;

export const PracticeResult = z
  .object({
    score: z.number().int(),
    correctCount: z.number().int(),
    total: z.number().int(),
  })
  .meta({ id: 'PracticeResult' });
export type PracticeResult = z.infer<typeof PracticeResult>;
