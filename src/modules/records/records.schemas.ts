import { z } from 'zod';
import { QUIZ_DIRECTION, QUIZ_MODE, STATS_PERIOD, STUDY_SOURCE } from '../../common/enums.js';
import { CursorQuery, cursorPage } from '../../common/pagination.js';

export const RecordListQuery = CursorQuery.extend({
  date: z.iso.date().optional().describe('KST 날짜 (달력에서 고른 날)'),
});
export type RecordListQuery = z.infer<typeof RecordListQuery>;

const recordSummaryShape = {
  recordId: z.string(),
  pack: z
    .object({ packId: z.string().nullable(), name: z.string().nullable() })
    .describe('팩이 삭제됐거나 팩 학습이 아니면 둘 다 null'),
  source: z.enum(STUDY_SOURCE),
  mode: z.enum(QUIZ_MODE),
  direction: z.enum(QUIZ_DIRECTION),
  correctCount: z.number().int(),
  wrongCount: z.number().int(),
  accuracy: z.number().nullable(),
  completedAt: z.iso.datetime(),
};

export const RecordSummary = z.object(recordSummaryShape).meta({ id: 'RecordSummary' });
export type RecordSummary = z.infer<typeof RecordSummary>;

export const RecordPage = cursorPage(RecordSummary).meta({ id: 'RecordPage' });

export const RecordDetail = z
  .object({
    ...recordSummaryShape,
    knownCount: z.number().int().nullable(),
    unknownCount: z.number().int().nullable(),
    items: z
      .array(
        z.object({
          index: z.number().int().describe('출제 순서'),
          wordId: z.string(),
          english: z.string(),
          meanings: z.array(z.string()),
          correct: z.boolean().nullable().describe('FLASHCARD는 null'),
          known: z.boolean().nullable().describe('FLASHCARD만'),
          userAnswer: z.string().nullable().describe('TYPING에서 입력한 답'),
        }),
      )
      .describe('답한 문항만. 영어·뜻은 학습을 끝낸 시점의 스냅샷'),
  })
  .meta({ id: 'RecordDetail' });
export type RecordDetail = z.infer<typeof RecordDetail>;

export const StreakStats = z
  .object({
    current: z.number().int().describe('오늘이나 어제까지 이어진 연속 학습일, 끊겼으면 0'),
    best: z.number().int(),
    todayDone: z.boolean(),
  })
  .meta({ id: 'StreakStats' });

export const CalendarQuery = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .describe('YYYY-MM (KST)'),
});

export const CalendarStats = z
  .object({
    month: z.string(),
    days: z
      .array(z.object({ date: z.string(), solvedCount: z.number().int() }))
      .describe('학습한 날만'),
  })
  .meta({ id: 'CalendarStats' });
export type CalendarStats = z.infer<typeof CalendarStats>;

export const SummaryQuery = z.object({ period: z.enum(STATS_PERIOD) });

export const SummaryStats = z
  .object({
    period: z.enum(STATS_PERIOD),
    studiedWordCount: z.number().int().describe('기간 안에 학습한 서로 다른 단어 수'),
    solvedCount: z.number().int(),
    correctCount: z.number().int(),
    accuracy: z
      .number()
      .nullable()
      .describe('4지선다·직접 입력의 정답률, 소수 첫째 자리. 푼 문제가 없으면 null'),
    series: z
      .array(
        z.object({
          date: z.string(),
          solvedCount: z.number().int(),
          accuracy: z.number().nullable(),
        }),
      )
      .describe('기간의 첫날부터 오늘까지 하루씩 (TODAY는 빈 배열)'),
  })
  .meta({ id: 'SummaryStats' });
export type SummaryStats = z.infer<typeof SummaryStats>;
