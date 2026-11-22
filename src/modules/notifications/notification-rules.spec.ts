import { describe, expect, it } from 'vitest';
import { NOTIFICATION_TYPE } from '../../common/enums.js';
import { CATEGORY_OF, isReminderTimeAllowed, REMINDER_TIME_PATTERN } from './notification-rules.js';

describe('notification rules', () => {
  it('학습 리마인더는 07:00~22:00만', () => {
    expect(isReminderTimeAllowed('07:00')).toBe(true);
    expect(isReminderTimeAllowed('22:00')).toBe(true);
    expect(isReminderTimeAllowed('06:59')).toBe(false);
    expect(isReminderTimeAllowed('22:01')).toBe(false);
  });

  it('시간 형식은 HH:mm', () => {
    expect(REMINDER_TIME_PATTERN.test('09:30')).toBe(true);
    expect(REMINDER_TIME_PATTERN.test('9:30')).toBe(false);
    expect(REMINDER_TIME_PATTERN.test('24:00')).toBe(false);
    expect(REMINDER_TIME_PATTERN.test('12:60')).toBe(false);
  });

  it('모든 알림 종류에 분류가 정해져 있다 (끌 수 없는 알림은 null)', () => {
    for (const type of NOTIFICATION_TYPE) expect(CATEGORY_OF[type]).not.toBeUndefined();
    expect(CATEGORY_OF.FRIEND_REQUEST).toBeNull();
    expect(CATEGORY_OF.BATTLE_INVITE).toBe('BATTLE');
  });
});
