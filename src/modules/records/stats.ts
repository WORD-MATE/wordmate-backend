/** 소수 첫째 자리 반올림, 분모가 0이면 null */
export const accuracyOf = (correct: number, graded: number): number | null =>
  graded > 0 ? Math.round((correct / graded) * 1000) / 10 : null;

/** 저장된 스트릭은 마지막 학습일 기준이라, 오늘이나 어제 학습하지 않았으면 끊긴 것(0)으로 보여준다 */
export function streakView(
  state: { current: number; best: number; lastDate: string | null } | null,
  today: string,
) {
  if (!state?.lastDate) return { current: 0, best: state?.best ?? 0, todayDone: false };
  const yesterday = Temporal.PlainDate.from(today).subtract({ days: 1 }).toString();
  const alive = state.lastDate === today || state.lastDate === yesterday;
  return {
    current: alive ? state.current : 0,
    best: state.best,
    todayDone: state.lastDate === today,
  };
}

/** from부터 to까지(둘 다 포함) 날짜 문자열 */
export function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  const end = Temporal.PlainDate.from(to);
  for (let day = Temporal.PlainDate.from(from); Temporal.PlainDate.compare(day, end) <= 0; ) {
    dates.push(day.toString());
    day = day.add({ days: 1 });
  }
  return dates;
}

/** 이번 주(월요일 시작)·이번 달의 첫날 (KST 날짜 문자열 기준) */
export function periodStart(period: 'TODAY' | 'WEEK' | 'MONTH', today: string): string {
  const day = Temporal.PlainDate.from(today);
  if (period === 'WEEK') return day.subtract({ days: day.dayOfWeek - 1 }).toString();
  if (period === 'MONTH') return day.with({ day: 1 }).toString();
  return today;
}
