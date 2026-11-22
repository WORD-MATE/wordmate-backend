import { z } from 'zod';
import { MORNING_QUIZ_TYPE } from '../../common/enums.js';
import { cursorPage } from '../../common/pagination.js';
import { packName } from '../packs/packs.schemas.js';
import { XpResult } from '../study/study.schemas.js';

export const MorningKeyword = z
  .object({
    index: z.number().int(),
    english: z.string(),
    meanings: z.array(z.string()),
    example: z.string().nullable(),
    highlight: z
      .object({ start: z.number().int(), end: z.number().int() })
      .describe('문장 안 위치. UTF-16 코드 단위, end는 포함하지 않음'),
  })
  .meta({ id: 'MorningKeyword' });

export const MorningQuiz = z
  .object({
    index: z.number().int(),
    type: z.enum(MORNING_QUIZ_TYPE),
    question: z.string(),
    choices: z.array(z.string()).nullable().describe('객관식만'),
    answers: z.array(z.string()).describe('허용 정답'),
    explanation: z.string().nullable(),
  })
  .meta({ id: 'MorningQuiz' });

export const MorningSentence = z
  .object({
    date: z.iso.date(),
    isFallback: z.boolean().describe('오늘 문장이 없어 가장 최근 문장을 줄 때 true'),
    sentence: z.string(),
    translation: z.string(),
    keywords: z.array(MorningKeyword),
    quizzes: z.array(MorningQuiz),
    completed: z.boolean().describe('이 날짜 퀴즈를 끝냈는지'),
    streak: z.object({ current: z.number().int() }),
  })
  .meta({ id: 'MorningSentence' });

export const MorningListItem = z
  .object({ date: z.iso.date(), sentence: z.string(), completed: z.boolean() })
  .meta({ id: 'MorningListItem' });
export const MorningList = cursorPage(MorningListItem).meta({ id: 'MorningList' });

export const CompleteMorningQuiz = z
  .object({
    answers: z
      .array(z.object({ index: z.number().int().min(0), answer: z.string().max(500) }))
      .min(1)
      .describe('모든 문항에 하나씩'),
  })
  .meta({ id: 'CompleteMorningQuiz' });
export type CompleteMorningQuiz = z.infer<typeof CompleteMorningQuiz>;

export const MorningQuizResult = z
  .object({
    correctCount: z.number().int(),
    total: z.number().int(),
    results: z.array(z.object({ index: z.number().int(), correct: z.boolean() })),
    xp: XpResult,
    alreadyCompletedToday: z.boolean().describe('오늘 이미 XP를 받았으면 true (추가 지급 없음)'),
    streak: z.object({ current: z.number().int(), increased: z.boolean() }),
  })
  .meta({ id: 'MorningQuizResult' });

export const SaveMorningWords = z
  .object({
    keywordIndexes: z.array(z.number().int().min(0)).min(1).nullish().describe('없으면 전체'),
    packId: z.uuid().optional().describe('기존 내 단어팩'),
    newPackName: packName.optional().describe('새 단어팩 이름'),
  })
  .refine((body) => (body.packId === undefined) !== (body.newPackName === undefined), {
    message: 'packId와 newPackName 중 하나만 보내야 합니다.',
    path: ['packId'],
  })
  .meta({ id: 'SaveMorningWords' });
export type SaveMorningWords = z.infer<typeof SaveMorningWords>;

export const SaveMorningWordsResult = z
  .object({
    packId: z.string(),
    saved: z.number().int(),
    skipped: z.number().int().describe('이미 있던 단어'),
  })
  .meta({ id: 'SaveMorningWordsResult' });

export type MorningSentence = z.infer<typeof MorningSentence>;
export type MorningListItem = z.infer<typeof MorningListItem>;
export type MorningQuizResult = z.infer<typeof MorningQuizResult>;
export type SaveMorningWordsResult = z.infer<typeof SaveMorningWordsResult>;
