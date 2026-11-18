import { describe, expect, it } from 'vitest';
import { kstDate, kstDayRange, kstMonthRange, kstWeekRange } from './kst.js';

const iso = ({ start, end }: { start: Date; end: Date }) => [
  start.toISOString(),
  end.toISOString(),
];

describe('kstDate', () => {
  it('UTC 15:00부터 KST 다음 날이다', () => {
    expect(kstDate(new Date('2026-11-18T14:59:59.999Z'))).toBe('2026-11-18');
    expect(kstDate(new Date('2026-11-18T15:00:00.000Z'))).toBe('2026-11-19');
  });
});

describe('kstDayRange', () => {
  it('KST 00:00 ~ 다음 날 00:00을 UTC로 돌려준다', () => {
    expect(iso(kstDayRange('2026-11-19'))).toEqual([
      '2026-11-18T15:00:00.000Z',
      '2026-11-19T15:00:00.000Z',
    ]);
  });
});

describe('kstWeekRange', () => {
  it('월요일 00:00에 시작한다', () => {
    const expected = ['2026-11-15T15:00:00.000Z', '2026-11-22T15:00:00.000Z'];
    expect(iso(kstWeekRange('2026-11-16'))).toEqual(expected);
    expect(iso(kstWeekRange('2026-11-19'))).toEqual(expected);
    expect(iso(kstWeekRange('2026-11-22'))).toEqual(expected);
  });
});

describe('kstMonthRange', () => {
  it('1일 00:00 ~ 다음 달 1일 00:00', () => {
    expect(iso(kstMonthRange('2026-12-31'))).toEqual([
      '2026-11-30T15:00:00.000Z',
      '2026-12-31T15:00:00.000Z',
    ]);
  });
});
