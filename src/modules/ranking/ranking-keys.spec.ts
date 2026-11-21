import { describe, expect, it } from 'vitest';
import {
  encodeScore,
  periodKey,
  previousPeriodDate,
  rankKey,
  scopeKeyFor,
  scopeKeys,
  topPercentOf,
  xpOfScore,
} from './ranking-keys.js';

describe('랭킹 점수', () => {
  it('XP가 같으면 먼저 도달한 쪽이 크고, XP가 다르면 XP가 우선', () => {
    const early = encodeScore(100, new Date('2026-11-16T00:00:00Z'));
    const late = encodeScore(100, new Date('2026-11-20T00:00:00Z'));
    const more = encodeScore(101, new Date('2027-06-01T00:00:00Z'));
    expect(early).toBeGreaterThan(late);
    expect(more).toBeGreaterThan(early);
  });

  it('점수에서 XP를 정확히 되돌린다 (큰 XP·늦은 시각 경계 포함)', () => {
    for (const xp of [0, 1, 499, 3500, 547_500, 899_999]) {
      for (const at of ['2026-01-01T00:00:00Z', '2026-11-20T12:34:56Z', '2030-12-31T23:59:59Z']) {
        const score = encodeScore(xp, new Date(at));
        expect(Number.isSafeInteger(score)).toBe(true);
        expect(xpOfScore(score)).toBe(xp);
      }
    }
  });
});

describe('랭킹 키', () => {
  it('주간은 그 주 월요일, 월간은 YYYY-MM, 전체는 all (KST 날짜 기준)', () => {
    expect(periodKey('WEEKLY', '2026-11-20')).toBe('2026-11-16');
    expect(periodKey('WEEKLY', '2026-11-16')).toBe('2026-11-16');
    expect(periodKey('WEEKLY', '2026-11-22')).toBe('2026-11-16');
    expect(periodKey('WEEKLY', '2026-03-01')).toBe('2026-02-23');
    expect(periodKey('MONTHLY', '2026-11-20')).toBe('2026-11');
    expect(periodKey('ALL', '2026-11-20')).toBe('all');
    expect(rankKey('WEEKLY', '2026-11-20', 'grade:2')).toBe('rank:weekly:2026-11-16:grade:2');
  });

  it('학생만, 학년·반이 있으면 학년·반 범위에도', () => {
    expect(scopeKeys({ role: 'STUDENT', grade: 2, classNo: 3 })).toEqual([
      'school',
      'grade:2',
      'class:2-3',
    ]);
    expect(scopeKeys({ role: 'STUDENT', grade: 1, classNo: null })).toEqual(['school', 'grade:1']);
    expect(scopeKeys({ role: 'STUDENT', grade: null, classNo: null })).toEqual(['school']);
    expect(scopeKeys({ role: 'TEACHER', grade: 2, classNo: 3 })).toEqual([]);
  });
});

describe('조회 도우미', () => {
  it('지난 기간: 주간은 7일 전, 월간은 지난달 말일, 전체는 없음', () => {
    expect(previousPeriodDate('WEEKLY', '2026-11-16')).toBe('2026-11-09');
    expect(previousPeriodDate('MONTHLY', '2026-03-15')).toBe('2026-02-28');
    expect(previousPeriodDate('MONTHLY', '2026-01-01')).toBe('2025-12-31');
    expect(previousPeriodDate('ALL', '2026-11-16')).toBeNull();
  });

  it('범위 키는 조회하는 사람의 학년·반 기준', () => {
    const me = { grade: 2, classNo: 3 };
    expect(scopeKeyFor('SCHOOL', me)).toBe('school');
    expect(scopeKeyFor('GRADE', me)).toBe('grade:2');
    expect(scopeKeyFor('CLASS', me)).toBe('class:2-3');
    expect(scopeKeyFor('CLASS', { grade: 2, classNo: null })).toBeNull();
    expect(scopeKeyFor('GRADE', { grade: null, classNo: null })).toBeNull();
  });

  it('상위 %는 올림, 1~100', () => {
    expect(topPercentOf(101, 400)).toBe(26);
    expect(topPercentOf(1, 1000)).toBe(1);
    expect(topPercentOf(400, 400)).toBe(100);
  });
});
