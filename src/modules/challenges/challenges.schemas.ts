import { z } from 'zod';
import { CompletePractice } from '../practice/practice.schemas.js';
import { XpResult } from '../study/study.schemas.js';

export const ChallengeToday = z
  .object({
    date: z.iso.date().describe('KST 날짜'),
    questionCount: z.number().int(),
    timeLimitSec: z.number().int(),
    participated: z.boolean().describe('오늘 시작했는지 (끝내지 않았어도 true)'),
    myResult: z
      .object({
        score: z.number().int(),
        correctCount: z.number().int(),
        xp: z.number().int().describe('받은 XP'),
      })
      .nullable()
      .describe('끝냈을 때만'),
  })
  .meta({ id: 'ChallengeToday' });
export type ChallengeToday = z.infer<typeof ChallengeToday>;

export const ChallengeAttempt = z
  .object({
    attemptId: z.string(),
    questions: z.array(
      z.object({ index: z.number().int(), prompt: z.string(), choices: z.array(z.string()) }),
    ),
  })
  .meta({ id: 'ChallengeAttempt' });
export type ChallengeAttempt = z.infer<typeof ChallengeAttempt>;

export const CompleteChallenge = CompletePractice.meta({ id: 'CompleteChallenge' });
export type CompleteChallenge = z.infer<typeof CompleteChallenge>;

export const ChallengeResult = z
  .object({
    score: z.number().int(),
    correctCount: z.number().int(),
    total: z.number().int(),
    results: z.array(
      z.object({ index: z.number().int(), correct: z.boolean(), answerIndex: z.number().int() }),
    ),
    xp: XpResult,
  })
  .meta({ id: 'ChallengeResult' });
export type ChallengeResult = z.infer<typeof ChallengeResult>;
