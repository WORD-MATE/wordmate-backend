import { z } from 'zod';
import { MORNING_QUIZ_TYPE, MORNING_STATUS } from '../../common/enums.js';
import { PageQuery, page } from '../../common/pagination.js';
import { Highlight, MorningKeywordInput, MorningQuizInput } from '../morning/morning-content.js';

export const ParseMorningText = z
  .object({ text: z.string().min(1).max(20_000).describe('게시물 본문') })
  .meta({ id: 'ParseMorningText' });

export const ParsedMorningResult = z
  .object({
    sentence: z.string().nullable(),
    translation: z.string().nullable(),
    keywords: z.array(
      z.object({
        english: z.string(),
        meanings: z.array(z.string()),
        example: z.string().nullable(),
      }),
    ),
    quizzes: z.array(
      z.object({
        type: z.enum(MORNING_QUIZ_TYPE),
        question: z.string(),
        choices: z.array(z.string()).nullable(),
        answers: z.array(z.string()),
        explanation: z.string().nullable(),
      }),
    ),
    warnings: z.array(z.string()),
  })
  .meta({ id: 'ParsedMorning' });

const text = z.string().trim().min(1).max(500);
const content = {
  date: z.iso.date().describe('게시 날짜 (KST, 06:00에 바뀜)'),
  sentence: text,
  translation: text,
  keywords: z.array(MorningKeywordInput).max(10),
  quizzes: z.array(MorningQuizInput).max(10),
};

export const CreateAdminMorning = z
  .object({
    ...content,
    keywords: content.keywords.default([]),
    quizzes: content.quizzes.default([]),
    replace: z.boolean().default(false).describe('같은 날짜의 게시 전 문장을 바꿀지'),
  })
  .meta({ id: 'CreateAdminMorning' });
export type CreateAdminMorning = z.infer<typeof CreateAdminMorning>;

export const UpdateAdminMorning = z
  .object({
    date: content.date.optional(),
    sentence: content.sentence.optional(),
    translation: content.translation.optional(),
    keywords: content.keywords.optional().describe('보내면 통째로 바꿈'),
    quizzes: content.quizzes.optional().describe('보내면 통째로 바꿈'),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), '바꿀 항목이 없습니다.')
  .meta({ id: 'UpdateAdminMorning' });
export type UpdateAdminMorning = z.infer<typeof UpdateAdminMorning>;

export const AdminMorningCreated = z
  .object({ morningId: z.string(), status: z.enum(MORNING_STATUS) })
  .meta({ id: 'AdminMorningCreated' });

export const AdminMorningQuery = PageQuery.extend({
  status: z.enum(MORNING_STATUS).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).refine((q) => !q.from || !q.to || q.from <= q.to, {
  message: '시작 날짜가 끝 날짜보다 늦습니다.',
  path: ['from'],
});
export type AdminMorningQuery = z.infer<typeof AdminMorningQuery>;

export const AdminMorningItem = z
  .object({
    morningId: z.string(),
    date: z.iso.date(),
    sentence: z.string(),
    status: z.enum(MORNING_STATUS),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminMorningItem' });
export type AdminMorningItem = z.infer<typeof AdminMorningItem>;
export const AdminMorningPage = page(AdminMorningItem).meta({ id: 'AdminMorningPage' });

export const AdminMorningDetail = z
  .object({
    morningId: z.string(),
    status: z.enum(MORNING_STATUS),
    date: z.iso.date(),
    sentence: z.string(),
    translation: z.string(),
    keywords: z.array(
      z.object({
        english: z.string(),
        meanings: z.array(z.string()),
        example: z.string().nullable(),
        highlight: Highlight,
      }),
    ),
    quizzes: z.array(
      z.object({
        type: z.enum(MORNING_QUIZ_TYPE),
        question: z.string(),
        choices: z.array(z.string()).nullable(),
        answers: z.array(z.string()),
        explanation: z.string().nullable(),
      }),
    ),
    updatedAt: z.iso.datetime(),
    updatedBy: z.string().nullable().describe('마지막으로 고친 관리자 이름 (시드는 null)'),
  })
  .meta({ id: 'AdminMorningDetail' });
export type AdminMorningDetail = z.infer<typeof AdminMorningDetail>;
