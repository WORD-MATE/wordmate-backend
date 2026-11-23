import { accuracyOf, streakView } from '../records/stats.js';

export interface StudentActivity {
  solvedCount: number;
  gradedCount: number;
  correctCount: number;
  studiedWordCount: number;
  streak: { current: number; best: number; lastDate: string | null } | null;
  battleCount: number;
  battleWinCount: number;
}

export const NO_ACTIVITY: StudentActivity = {
  solvedCount: 0,
  gradedCount: 0,
  correctCount: 0,
  studiedWordCount: 0,
  streak: null,
  battleCount: 0,
  battleWinCount: 0,
};

export function studentMetrics(activity: StudentActivity, today: string) {
  return {
    participated: activity.solvedCount > 0,
    studiedWordCount: activity.studiedWordCount,
    accuracy: accuracyOf(activity.correctCount, activity.gradedCount),
    streak: streakView(activity.streak, today).current,
    battleCount: activity.battleCount,
    battleWinCount: activity.battleWinCount,
  };
}

const round1 = (value: number) => Math.round(value * 10) / 10;

/** 평균 정답률은 학생마다 같은 비중으로 본다 (많이 푼 학생이 반 평균을 끌고 가지 않게) */
export function classSummary(students: { participated: boolean; accuracy: number | null }[]) {
  const studentCount = students.length;
  const participants = students.filter((s) => s.participated).length;
  const accuracies = students.flatMap((s) => (s.accuracy === null ? [] : [s.accuracy]));
  return {
    studentCount,
    participationRate: studentCount > 0 ? round1((participants / studentCount) * 100) : 0,
    avgAccuracy:
      accuracies.length > 0
        ? round1(accuracies.reduce((sum, a) => sum + a, 0) / accuracies.length)
        : null,
  };
}
