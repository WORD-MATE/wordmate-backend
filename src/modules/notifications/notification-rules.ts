import {
  type NotificationCategory,
  type NotificationType,
  WEEKDAY,
  type Weekday,
} from '../../common/enums.js';

/**
 * 알림 종류가 속한 설정 분류. null이면 끌 수 없는 알림 (친구·배지·문의 답변·제재 등 계정·관계에 관한 것)
 */
export const CATEGORY_OF: Record<NotificationType, NotificationCategory | null> = {
  BATTLE_INVITE: 'BATTLE',
  BATTLE_RESULT: 'BATTLE',
  RANK_DROP: 'RANKING',
  RANK_WEEKLY_RESULT: 'RANKING',
  STUDY_REMINDER: 'STUDY_REMINDER',
  MORNING_SENTENCE: 'MORNING_SENTENCE',
  NOTICE: 'NOTICE',
  MARKETING: 'MARKETING',
  INQUIRY_ANSWERED: null,
  FRIEND_REQUEST: null,
  FRIEND_ACCEPTED: null,
  BADGE_EARNED: null,
  SANCTION: null,
  REPORT_RESULT: null,
  NEW_DEVICE_LOGIN: null,
  ADMIN_ALERT: null,
};

export type CategorySettings = Record<NotificationCategory, boolean>;

/** 설정을 한 번도 바꾸지 않은 사용자: 광고성만 끄고 모두 켬, 학습 리마인더 시간은 없음(보내지 않음) */
export const DEFAULT_CATEGORIES: CategorySettings = {
  STUDY_REMINDER: true,
  MORNING_SENTENCE: true,
  BATTLE: true,
  RANKING: true,
  NOTICE: true,
  MARKETING: false,
};
export const DEFAULT_REMINDER_WEEKDAYS: Weekday[] = [...WEEKDAY];

/** 학습 리마인더는 07:00~22:00 사이만 (야간 발송 금지) */
export const REMINDER_EARLIEST = '07:00';
export const REMINDER_LATEST = '22:00';
export const REMINDER_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isReminderTimeAllowed(time: string): boolean {
  return time >= REMINDER_EARLIEST && time <= REMINDER_LATEST;
}

/** 알림 목록을 보관하는 기간 */
export const NOTIFICATION_RETENTION_DAYS = 30;
