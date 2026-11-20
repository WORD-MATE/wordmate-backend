import { describe, expect, it } from 'vitest';
import { accuracyOf, datesBetween, periodStart, streakView } from './stats.js';

describe('accuracyOf', () => {
  it('소수 첫째 자리 반올림, 분모가 0이면 null', () => {
    expect(accuracyOf(2, 3)).toBe(66.7);
    expect(accuracyOf(1, 8)).toBe(12.5);
    expect(accuracyOf(0, 0)).toBeNull();
  });
});

describe('streakView', () => {
  it('오늘·어제까지 이어졌으면 그대로, 끊겼으면 0 (최고 기록은 유지)', () => {
    const state = (lastDate: string) => ({ current: 5, best: 9, lastDate });
    expect(streakView(state('2026-11-20'), '2026-11-20')).toEqual({
      current: 5,
      best: 9,
      todayDone: true,
    });
    expect(streakView(state('2026-11-19'), '2026-11-20')).toEqual({
      current: 5,
      best: 9,
      todayDone: false,
    });
    expect(streakView(state('2026-11-18'), '2026-11-20')).toEqual({
      current: 0,
      best: 9,
      todayDone: false,
    });
    expect(streakView(null, '2026-11-20')).toEqual({ current: 0, best: 0, todayDone: false });
  });
});

describe('기간', () => {
  it('이번 주는 월요일부터, 이번 달은 1일부터', () => {
    // 2026-11-20은 금요일
    expect(periodStart('WEEK', '2026-11-20')).toBe('2026-11-16');
    expect(periodStart('WEEK', '2026-11-16')).toBe('2026-11-16');
    expect(periodStart('WEEK', '2026-11-22')).toBe('2026-11-16');
    expect(periodStart('MONTH', '2026-11-20')).toBe('2026-11-01');
    expect(periodStart('TODAY', '2026-11-20')).toBe('2026-11-20');
  });

  it('datesBetween은 양 끝을 포함하고 달을 넘어간다', () => {
    expect(datesBetween('2026-10-30', '2026-11-02')).toEqual([
      '2026-10-30',
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
    expect(datesBetween('2026-11-20', '2026-11-20')).toEqual(['2026-11-20']);
  });
});
