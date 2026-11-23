import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, desc, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import type { NotificationCategory, NotificationType } from '../../common/enums.js';
import { AppException } from '../../common/errors/app-exception.js';
import { decodeCursor, toCursorPage } from '../../common/pagination.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { notificationSettings, notifications, users } from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { PushService } from '../push/push.service.js';
import { AgreementService } from '../users/agreement.service.js';
import {
  CATEGORY_OF,
  type CategorySettings,
  DEFAULT_CATEGORIES,
  DEFAULT_REMINDER_WEEKDAYS,
  isReminderTimeAllowed,
  NOTIFICATION_RETENTION_DAYS,
} from './notification-rules.js';
import type {
  NotificationItem,
  NotificationListQuery,
  NotificationSettings,
  UpdateNotificationSettings,
} from './notifications.schemas.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const ListCursor = z.object({ id: z.uuid() });
const NOTIFY_CHUNK = 1000;

export const NotificationErrors = {
  notFound: () =>
    new AppException('NOTI_NOT_FOUND', '알림을 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
  reminderTimeOutOfRange: () =>
    new AppException(
      'NOTI_REMINDER_TIME_OUT_OF_RANGE',
      '학습 리마인더는 07:00~22:00 사이로 정할 수 있습니다.',
      HttpStatus.BAD_REQUEST,
    ),
  marketingAgreementRequired: () =>
    new AppException(
      'NOTI_MARKETING_AGREEMENT_REQUIRED',
      '마케팅 정보 수신에 동의해야 켤 수 있습니다.',
      HttpStatus.BAD_REQUEST,
    ),
};

export type NewNotification = {
  type: NotificationType;
  title: string;
  body: string;
  route?: string | null;
};

export type StoredNotification = NewNotification & { id: string; userId: string };

const COLUMN_OF = {
  STUDY_REMINDER: 'studyReminder',
  MORNING_SENTENCE: 'morningSentence',
  BATTLE: 'battle',
  RANKING: 'ranking',
  NOTICE: 'notice',
  MARKETING: 'marketing',
} as const satisfies Record<NotificationCategory, keyof typeof notificationSettings.$inferSelect>;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly agreements: AgreementService,
    private readonly push: PushService,
  ) {}

  /**
   * 알림을 저장한다. 그 분류를 끈 사용자(광고성은 마케팅 동의를 철회한 사용자도)에게는 저장하지 않는다.
   * 다른 기능은 이것으로 알림을 보낸다. 저장한 알림을 돌려준다 (푸시 발송에 쓴다)
   */
  async notify(userIds: string[], notification: NewNotification): Promise<StoredNotification[]> {
    const stored: StoredNotification[] = [];
    const unique = [...new Set(userIds)];
    // 전체 공지처럼 받는 사람이 많아도 한 문장이 너무 커지지 않게 나눠 처리한다
    for (let i = 0; i < unique.length; i += NOTIFY_CHUNK) {
      const active = await this.activeUsers(unique.slice(i, i + NOTIFY_CHUNK));
      const recipients = await this.allowed(active, notification.type);
      if (recipients.length === 0) continue;
      const rows = recipients.map((userId) => ({
        id: newId(),
        userId,
        type: notification.type,
        title: notification.title,
        body: notification.body,
        route: notification.route ?? null,
      }));
      await this.db.insert(notifications).values(rows);
      stored.push(...rows);
    }
    // 푸시를 넣지 못해도 알림은 이미 저장돼 있으므로 기록만 한다
    await this.push
      .dispatch(stored.map((row) => ({ ...row, notificationId: row.id, route: row.route ?? null })))
      .catch((error: unknown) => this.logger.warn(`푸시 작업 추가 실패: ${String(error)}`));
    return stored;
  }

  /** 지금 쓰는 계정만 (탈퇴·정지·휴면 계정과 없는 사용자는 빼서 외래 키 오류로 전체가 실패하지 않게) */
  private async activeUsers(userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(inArray(users.id, userIds), eq(users.status, 'ACTIVE')));
    const active = new Set(rows.map((row) => row.id));
    return userIds.filter((userId) => active.has(userId));
  }

  async list(user: AuthUser, query: NotificationListQuery) {
    const cursor = query.cursor ? decodeCursor(query.cursor, ListCursor) : null;
    const rows = await this.db
      .select()
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, user.userId),
          gt(notifications.createdAt, this.retentionStart()),
          cursor ? lt(notifications.id, cursor.id) : undefined,
        ),
      )
      .orderBy(desc(notifications.id))
      .limit(query.size + 1);
    const items: NotificationItem[] = rows.map((row) => ({
      notificationId: row.id,
      type: row.type,
      title: row.title,
      body: row.body,
      route: row.route,
      read: row.readAt !== null,
      createdAt: row.createdAt.toISOString(),
    }));
    return toCursorPage(items, query.size, (last) => ({ id: last.notificationId }));
  }

  async unreadCount(user: AuthUser): Promise<{ count: number }> {
    const [row] = await this.db
      .select({ total: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, user.userId),
          isNull(notifications.readAt),
          gt(notifications.createdAt, this.retentionStart()),
        ),
      );
    return { count: row?.total ?? 0 };
  }

  /** 남의 알림·보관 기간이 지난 알림이면 404. 이미 읽었으면 그대로 둔다 */
  async read(user: AuthUser, notificationId: string): Promise<void> {
    const mine = and(
      eq(notifications.id, notificationId),
      eq(notifications.userId, user.userId),
      gt(notifications.createdAt, this.retentionStart()),
    );
    const [row] = await this.db.select({ id: notifications.id }).from(notifications).where(mine);
    if (!row) throw NotificationErrors.notFound();
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(mine, isNull(notifications.readAt)));
  }

  async readAll(user: AuthUser): Promise<void> {
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        and(
          eq(notifications.userId, user.userId),
          isNull(notifications.readAt),
          gt(notifications.createdAt, this.retentionStart()),
        ),
      );
  }

  async settings(user: AuthUser): Promise<NotificationSettings> {
    const [row] = await this.db
      .select()
      .from(notificationSettings)
      .where(eq(notificationSettings.userId, user.userId));
    const marketingAgreed = await this.agreements.marketingAgreed(user.userId);
    const categories = row ? this.categoriesOf(row) : { ...DEFAULT_CATEGORIES };
    // 동의를 철회했으면 광고성은 실제로 받지 않으므로 꺼진 것으로 보여 준다 (그대로 다시 저장해도 막히지 않게)
    categories.MARKETING = categories.MARKETING && marketingAgreed;
    return {
      categories,
      reminder: {
        time: row?.reminderTime ?? null,
        weekdays: row?.reminderWeekdays ?? [...DEFAULT_REMINDER_WEEKDAYS],
      },
      marketingAgreed,
    };
  }

  /** 계정 단위로 저장해 모든 기기에 같이 적용한다 */
  async updateSettings(
    user: AuthUser,
    body: UpdateNotificationSettings,
  ): Promise<NotificationSettings> {
    if (body.reminder.time !== null && !isReminderTimeAllowed(body.reminder.time)) {
      throw NotificationErrors.reminderTimeOutOfRange();
    }
    if (body.categories.MARKETING && !(await this.agreements.marketingAgreed(user.userId))) {
      throw NotificationErrors.marketingAgreementRequired();
    }
    const values = {
      studyReminder: body.categories.STUDY_REMINDER,
      morningSentence: body.categories.MORNING_SENTENCE,
      battle: body.categories.BATTLE,
      ranking: body.categories.RANKING,
      notice: body.categories.NOTICE,
      marketing: body.categories.MARKETING,
      reminderTime: body.reminder.time,
      reminderWeekdays: body.reminder.weekdays,
    };
    await this.db
      .insert(notificationSettings)
      .values({ userId: user.userId, ...values })
      .onDuplicateKeyUpdate({ set: values });
    return this.settings(user);
  }

  private retentionStart(now = new Date()): Date {
    return new Date(now.getTime() - NOTIFICATION_RETENTION_DAYS * DAY_MS);
  }

  private categoriesOf(row: typeof notificationSettings.$inferSelect): CategorySettings {
    return Object.fromEntries(
      Object.entries(COLUMN_OF).map(([category, column]) => [category, row[column]]),
    ) as CategorySettings;
  }

  private async allowed(userIds: string[], type: NotificationType): Promise<string[]> {
    const category = CATEGORY_OF[type];
    if (!category || userIds.length === 0) return userIds;
    const rows = await this.db
      .select()
      .from(notificationSettings)
      .where(inArray(notificationSettings.userId, userIds));
    const settingOf = new Map(rows.map((row) => [row.userId, row[COLUMN_OF[category]]]));
    const enabled = userIds.filter(
      (userId) => settingOf.get(userId) ?? DEFAULT_CATEGORIES[category],
    );
    if (category !== 'MARKETING') return enabled;
    // 광고성은 마케팅 동의를 철회했으면 켜 둔 설정과 상관없이 보내지 않는다
    const agreed = await this.agreements.marketingAgreedAmong(enabled);
    return enabled.filter((userId) => agreed.has(userId));
  }
}
