import { z } from 'zod';
import { INQUIRY_STATUS, INQUIRY_TYPE, PLATFORM } from '../../common/enums.js';
import { cursorPage, PageQuery, page } from '../../common/pagination.js';

/** multipart 필드라 모두 문자열로 온다 */
export const CreateInquiry = z
  .object({
    type: z.enum(INQUIRY_TYPE),
    title: z.string().trim().min(1).max(50),
    content: z.string().trim().min(10).max(1000),
  })
  .meta({ id: 'CreateInquiry' });
export type CreateInquiry = z.infer<typeof CreateInquiry>;

export const InquiryCreated = z.object({ inquiryId: z.string() }).meta({ id: 'InquiryCreated' });

export const InquiryListItem = z
  .object({
    inquiryId: z.string(),
    type: z.enum(INQUIRY_TYPE),
    title: z.string(),
    status: z.enum(INQUIRY_STATUS),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'InquiryListItem' });
export type InquiryListItem = z.infer<typeof InquiryListItem>;
export const InquiryList = cursorPage(InquiryListItem).meta({ id: 'InquiryList' });

export const InquiryDetail = z
  .object({
    inquiryId: z.string(),
    type: z.enum(INQUIRY_TYPE),
    title: z.string(),
    content: z.string(),
    images: z.array(
      z.object({
        imageId: z.string(),
        url: z.string().describe('서명한 주소, 10분 동안 로그인 없이 열림'),
      }),
    ),
    status: z.enum(INQUIRY_STATUS),
    answer: z
      .object({
        content: z.string(),
        answeredAt: z.iso.datetime().describe('마지막으로 답변을 쓰거나 고친 시각'),
      })
      .nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'InquiryDetail' });
export type InquiryDetail = z.infer<typeof InquiryDetail>;

export const ImageUrlQuery = z.object({
  exp: z.string().optional(),
  sig: z.string().optional(),
});

export const AdminInquiryQuery = PageQuery.extend({
  status: z.enum(INQUIRY_STATUS).optional(),
  type: z.enum(INQUIRY_TYPE).optional(),
});
export type AdminInquiryQuery = z.infer<typeof AdminInquiryQuery>;

export const AdminInquiryItem = z
  .object({
    inquiryId: z.string(),
    user: z.object({ userId: z.string(), name: z.string() }),
    type: z.enum(INQUIRY_TYPE),
    title: z.string(),
    status: z.enum(INQUIRY_STATUS),
    platform: z.enum(PLATFORM),
    appVersion: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminInquiry' });
export type AdminInquiryItem = z.infer<typeof AdminInquiryItem>;
export const AdminInquiryPage = page(AdminInquiryItem).meta({ id: 'AdminInquiryPage' });

export const AnswerInquiry = z
  .object({ content: z.string().trim().min(1).max(2000) })
  .meta({ id: 'AnswerInquiry' });
export type AnswerInquiry = z.infer<typeof AnswerInquiry>;
