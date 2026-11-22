import { z } from 'zod';
import { FAQ_CATEGORY } from '../../common/enums.js';

export const FaqQuery = z.object({ category: z.enum(FAQ_CATEGORY).optional() });

export const FaqItem = z
  .object({
    faqId: z.string(),
    category: z.enum(FAQ_CATEGORY),
    question: z.string(),
    answer: z.string().describe('Markdown'),
    order: z.number().int().describe('분류 안 순서'),
  })
  .meta({ id: 'Faq' });
export const FaqList = z.array(FaqItem).meta({ id: 'FaqList' });

const fields = {
  category: z.enum(FAQ_CATEGORY),
  question: z.string().trim().min(1).max(200),
  answer: z.string().trim().min(1).max(20_000),
  order: z.number().int().min(0).max(10_000).describe('분류 안 순서, 작을수록 먼저'),
};

export const CreateFaq = z
  .object({ ...fields, order: fields.order.optional() })
  .meta({ id: 'CreateFaq' });
export type CreateFaq = z.infer<typeof CreateFaq>;

export const UpdateFaq = z
  .object({
    category: fields.category.optional(),
    question: fields.question.optional(),
    answer: fields.answer.optional(),
    order: fields.order.optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), '바꿀 항목이 없습니다.')
  .meta({ id: 'UpdateFaq' });
export type UpdateFaq = z.infer<typeof UpdateFaq>;

export const FaqCreated = z.object({ faqId: z.string() }).meta({ id: 'FaqCreated' });
