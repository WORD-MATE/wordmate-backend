import { describe, expect, it } from 'vitest';
import { expiresAtOf, periodKeyOf } from './mission-progress.js';

describe('periodKeyOf', () => {
  it('일일은 KST 날짜, 주간은 그 주 월요일', () => {
    // 2026-11-22(일) 23:30 KST
    const sunday = new Date('2026-11-22T14:30:00Z');
    expect(periodKeyOf('DAILY', sunday)).toBe('2026-11-22');
    expect(periodKeyOf('WEEKLY', sunday)).toBe('2026-11-16');
    // 2026-11-23(월) 00:10 KST
    const monday = new Date('2026-11-22T15:10:00Z');
    expect(periodKeyOf('DAILY', monday)).toBe('2026-11-23');
    expect(periodKeyOf('WEEKLY', monday)).toBe('2026-11-23');
  });

  it('만료는 다음 날·다음 월요일 00:00 KST', () => {
    const at = new Date('2026-11-18T03:00:00Z');
    expect(expiresAtOf('DAILY', at).toISOString()).toBe('2026-11-18T15:00:00.000Z');
    expect(expiresAtOf('WEEKLY', at).toISOString()).toBe('2026-11-22T15:00:00.000Z');
  });
});
