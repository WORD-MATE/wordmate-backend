import { z } from 'zod';
import { PageQuery, page } from '../../common/pagination.js';

export const NoticeListItem = z
  .object({
    noticeId: z.string(),
    title: z.string(),
    pinned: z.boolean(),
    read: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'NoticeListItem' });
export type NoticeListItem = z.infer<typeof NoticeListItem>;
export const NoticeList = z
  .object({ items: z.array(NoticeListItem), nextCursor: z.string().nullable() })
  .meta({ id: 'NoticeList' });

export const NoticeDetail = z
  .object({
    noticeId: z.string(),
    title: z.string(),
    content: z.string().describe('Markdown'),
    pinned: z.boolean(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'NoticeDetail' });

const title = z.string().trim().min(1).max(100);
const content = z.string().trim().min(1).max(50_000);

export const CreateNotice = z
  .object({
    title,
    content,
    pinned: z.boolean().default(false),
    published: z.boolean().default(true).describe('false면 관리자만 보는 초안'),
    sendPush: z
      .boolean()
      .default(false)
      .describe('공개 공지일 때 전체 사용자에게 NOTICE 알림 (공지 알림을 끈 사람 제외)'),
  })
  .meta({ id: 'CreateNotice' });
export type CreateNotice = z.infer<typeof CreateNotice>;

export const UpdateNotice = z
  .object({
    title: title.optional(),
    content: content.optional(),
    pinned: z.boolean().optional(),
    published: z.boolean().optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), '바꿀 항목이 없습니다.')
  .meta({ id: 'UpdateNotice' });
export type UpdateNotice = z.infer<typeof UpdateNotice>;

export const NoticeCreated = z.object({ noticeId: z.string() }).meta({ id: 'NoticeCreated' });

export const AdminNoticeQuery = PageQuery;
export const AdminNoticeItem = z
  .object({
    noticeId: z.string(),
    title: z.string(),
    pinned: z.boolean(),
    published: z.boolean(),
    createdBy: z.string().nullable(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'AdminNotice' });
export type AdminNoticeItem = z.infer<typeof AdminNoticeItem>;
export const AdminNoticePage = page(AdminNoticeItem).meta({ id: 'AdminNoticePage' });
