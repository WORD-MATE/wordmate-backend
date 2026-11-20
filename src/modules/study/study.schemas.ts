import { z } from 'zod';
import {
  QUIZ_DIRECTION,
  QUIZ_MODE,
  STUDY_SESSION_STATUS,
  STUDY_SOURCE,
} from '../../common/enums.js';
import { MAX_WORDS_PER_PACK } from '../words/words.schemas.js';

export const QUESTION_COUNTS = [10, 20, 30] as const;

export const StartStudy = z
  .object({
    source: z.enum(STUDY_SOURCE),
    packId: z.uuid().optional().describe('source=PACK일 때 필수'),
    recordId: z.uuid().optional().describe('source=RECORD_WRONG일 때 필수'),
    wordIds: z
      .array(z.uuid())
      .min(1)
      .max(MAX_WORDS_PER_PACK)
      .nullish()
      .describe('오답노트·즐겨찾기에서 고른 단어. 없으면 전체'),
    mode: z.enum(QUIZ_MODE),
    direction: z.enum(QUIZ_DIRECTION),
    questionCount: z
      .union(QUESTION_COUNTS.map((count) => z.literal(count)))
      .nullish()
      .describe('없으면 전체. 단어 수보다 많으면 전체로 맞춤'),
    shuffle: z.boolean(),
    force: z.boolean().default(false).describe('true면 이어할 학습을 버리고 새로 시작'),
  })
  .refine((body) => body.source !== 'PACK' || body.packId, {
    message: 'packId가 필요합니다.',
    path: ['packId'],
  })
  .refine((body) => body.source !== 'RECORD_WRONG' || body.recordId, {
    message: 'recordId가 필요합니다.',
    path: ['recordId'],
  })
  .meta({ id: 'StartStudy' });
export type StartStudy = z.infer<typeof StartStudy>;

const StudyPack = z.object({ packId: z.string(), name: z.string() }).nullable();

export const StudyQuestion = z
  .object({
    index: z.number().int(),
    wordId: z.string(),
    prompt: z.string().describe('EN_TO_KO면 영어, KO_TO_EN이면 뜻 전체를 ", "로 연결'),
    derivatives: z.array(z.string()),
    choices: z.array(z.string()).nullable().describe('CHOICE만, 4개'),
    answerIndex: z
      .number()
      .int()
      .nullable()
      .describe('CHOICE만. 채점은 답안 제출 때 서버가 다시 함'),
    card: z
      .object({ english: z.string(), meanings: z.array(z.string()) })
      .nullable()
      .describe('FLASHCARD만, 카드 뒷면'),
  })
  .meta({ id: 'StudyQuestion' });

export const StudyAnswer = z
  .object({
    index: z.number().int(),
    correct: z.boolean().nullable(),
    known: z.boolean().nullable(),
    userAnswer: z.string().nullable(),
  })
  .meta({ id: 'StudyAnswer' });

export const StudySession = z
  .object({
    sessionId: z.string(),
    source: z.enum(STUDY_SOURCE),
    pack: StudyPack,
    mode: z.enum(QUIZ_MODE),
    direction: z.enum(QUIZ_DIRECTION),
    status: z.enum(STUDY_SESSION_STATUS),
    startedAt: z.iso.datetime(),
    questions: z.array(StudyQuestion).describe('출제 순서. 만들 때 고정'),
    answers: z.array(StudyAnswer).describe('제출한 문항만'),
  })
  .meta({ id: 'StudySession' });
export type StudySession = z.infer<typeof StudySession>;

export const CurrentStudy = z
  .object({
    sessionId: z.string(),
    source: z.enum(STUDY_SOURCE),
    pack: StudyPack,
    mode: z.enum(QUIZ_MODE),
    answered: z.number().int(),
    total: z.number().int(),
    updatedAt: z.iso.datetime(),
  })
  .nullable()
  .meta({ id: 'CurrentStudy' });
export type CurrentStudy = z.infer<typeof CurrentStudy>;
