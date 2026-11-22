import { z } from 'zod';
import { NOTIFICATION_CATEGORY, NOTIFICATION_TYPE, WEEKDAY } from '../../common/enums.js';
import { CursorQuery, cursorPage } from '../../common/pagination.js';
import { REMINDER_TIME_PATTERN } from './notification-rules.js';

export const NotificationListQuery = CursorQuery;
export type NotificationListQuery = z.infer<typeof NotificationListQuery>;

export const NotificationItem = z.object({
  notificationId: z.string(),
  type: z.enum(NOTIFICATION_TYPE),
  title: z.string(),
  body: z.string(),
  route: z.string().nullable().describe('눌렀을 때 이동할 앱 경로'),
  read: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type NotificationItem = z.infer<typeof NotificationItem>;

export const NotificationPage = cursorPage(NotificationItem).meta({ id: 'NotificationPage' });

export const UnreadCount = z.object({ count: z.number().int() }).meta({ id: 'UnreadCount' });

const categories = z.object(
  Object.fromEntries(NOTIFICATION_CATEGORY.map((category) => [category, z.boolean()])) as Record<
    (typeof NOTIFICATION_CATEGORY)[number],
    z.ZodBoolean
  >,
);

const reminder = z.object({
  time: z
    .string()
    .regex(REMINDER_TIME_PATTERN, 'HH:mm 형식이어야 합니다.')
    .nullable()
    .describe('KST HH:mm (07:00~22:00), null이면 보내지 않음'),
  weekdays: z
    .array(z.enum(WEEKDAY))
    .max(WEEKDAY.length)
    .refine((days) => new Set(days).size === days.length, { message: '요일이 겹칩니다.' }),
});

export const NotificationSettings = z
  .object({
    categories,
    reminder,
    marketingAgreed: z.boolean().describe('마케팅 수신 동의 여부 (약관 동의에서 바꿈)'),
  })
  .meta({ id: 'NotificationSettings' });
export type NotificationSettings = z.infer<typeof NotificationSettings>;

export const UpdateNotificationSettings = z
  .object({ categories, reminder })
  .meta({ id: 'UpdateNotificationSettings' });
export type UpdateNotificationSettings = z.infer<typeof UpdateNotificationSettings>;
