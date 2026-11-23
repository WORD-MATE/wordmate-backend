import { describe, expect, it } from 'vitest';
import { classSummary, NO_ACTIVITY, studentMetrics } from './class-dashboard.js';

describe('반 대시보드 계산', () => {
  it('기간 안에 답을 냈으면 참여, 정답률은 채점한 답만 본다', () => {
    expect(
      studentMetrics(
        {
          ...NO_ACTIVITY,
          solvedCount: 12,
          gradedCount: 8,
          correctCount: 6,
          studiedWordCount: 10,
          battleCount: 3,
          battleWinCount: 1,
        },
        '2026-11-23',
      ),
    ).toEqual({
      participated: true,
      studiedWordCount: 10,
      accuracy: 75,
      streak: 0,
      battleCount: 3,
      battleWinCount: 1,
    });
    expect(studentMetrics(NO_ACTIVITY, '2026-11-23')).toMatchObject({
      participated: false,
      accuracy: null,
    });
  });

  it('연속 학습은 오늘이나 어제 학습했을 때만 이어진다', () => {
    const streak = (lastDate: string) =>
      studentMetrics({ ...NO_ACTIVITY, streak: { current: 4, best: 6, lastDate } }, '2026-11-23')
        .streak;
    expect(streak('2026-11-23')).toBe(4);
    expect(streak('2026-11-22')).toBe(4);
    expect(streak('2026-11-21')).toBe(0);
  });

  it('참여율은 전체 학생 대비, 평균 정답률은 정답률이 있는 학생끼리 같은 비중으로', () => {
    expect(
      classSummary([
        { participated: true, accuracy: 100 },
        { participated: true, accuracy: 50 },
        { participated: true, accuracy: null },
      ]),
    ).toEqual({ studentCount: 3, participationRate: 100, avgAccuracy: 75 });
    expect(
      classSummary([
        { participated: true, accuracy: 33.3 },
        { participated: false, accuracy: null },
        { participated: false, accuracy: null },
      ]),
    ).toEqual({ studentCount: 3, participationRate: 33.3, avgAccuracy: 33.3 });
    expect(classSummary([])).toEqual({ studentCount: 0, participationRate: 0, avgAccuracy: null });
  });
});
