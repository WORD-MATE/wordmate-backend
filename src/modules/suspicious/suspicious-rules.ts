import { DAILY_PAIR_LIMIT } from '../battles/battle-rules.js';

/** 하루 답이 이보다 적으면 빠른 답 비율을 보지 않는다 (임시값) */
export const FAST_ANSWER_MIN_COUNT = 30;
/** 하루 답 중 너무 빨리 낸 답(점수에서 빠지는 답)의 비율이 이 이상이면 표시 (임시값) */
export const FAST_ANSWER_RATIO = 0.5;
/** 같은 상대와 하루에 이만큼 대결하면 표시. XP가 멈춘 뒤에도 계속한 경우 (임시값) */
export const REPEATED_OPPONENT_MIN = DAILY_PAIR_LIMIT + 1;
/** 하루 XP 상한을 이만큼 연속으로 채우면 표시 (임시값) */
export const XP_SPIKE_CAP_DAYS = 3;
/** 연속 일수를 셀 때 거슬러 보는 날 수 */
export const XP_SPIKE_LOOKBACK_DAYS = 7;

export function fastAnswerEvidence(answerCount: number, fastCount: number) {
  if (answerCount < FAST_ANSWER_MIN_COUNT) return null;
  const fastRatio = fastCount / answerCount;
  if (fastRatio < FAST_ANSWER_RATIO) return null;
  return { answerCount, fastCount, fastRatio: Math.round(fastRatio * 1000) / 1000 };
}

export function repeatedOpponentEvidence(rows: { opponentId: string; count: number }[]) {
  const opponents = rows
    .filter((row) => row.count >= REPEATED_OPPONENT_MIN)
    .sort((a, b) => b.count - a.count)
    .map((row) => ({ userId: row.opponentId, battleCount: row.count }));
  return opponents.length > 0 ? { opponents } : null;
}

/** date부터 거꾸로 상한을 채운 날이 며칠 이어지는지 */
export function capStreak(xpByDate: Map<string, number>, date: string, cap: number): number {
  let streak = 0;
  let day = Temporal.PlainDate.from(date);
  while (streak < XP_SPIKE_LOOKBACK_DAYS && (xpByDate.get(day.toString()) ?? 0) >= cap) {
    streak++;
    day = day.subtract({ days: 1 });
  }
  return streak;
}

export function xpSpikeEvidence(xpByDate: Map<string, number>, date: string, cap: number) {
  const streak = capStreak(xpByDate, date, cap);
  if (streak < XP_SPIKE_CAP_DAYS) return null;
  const daily = Array.from({ length: streak }, (_, i) => {
    const day = Temporal.PlainDate.from(date).subtract({ days: i }).toString();
    return { date: day, xp: xpByDate.get(day) ?? 0 };
  });
  return { capDays: streak, daily };
}
