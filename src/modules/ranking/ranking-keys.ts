import type { RankPeriod } from '../../common/enums.js';

/**
 * 점수 = XP × XP_FACTOR + (XP_FACTOR - 1 - 도달 시각 초).
 * 같은 XP면 먼저 도달한(초가 작은) 사용자의 점수가 크다. double 정수 범위(2^53) 안에서
 * XP 약 90만까지 정확하다
 */
export const XP_FACTOR = 1e10;
/** 도달 시각 기준점 (2026-01-01T00:00:00Z) */
const EPOCH_SECONDS = 1_767_225_600;

/** 도달 시각 부분. 늦게 도달할수록 작다 */
export const tiebreakOf = (reachedAt: Date): number =>
  XP_FACTOR - 1 - (Math.floor(reachedAt.getTime() / 1000) - EPOCH_SECONDS);

export const encodeScore = (xp: number, reachedAt: Date): number =>
  xp * XP_FACTOR + tiebreakOf(reachedAt);

/** 나눗셈 반올림으로 XP가 1 커지지 않게 나머지를 먼저 뺀다 */
export const xpOfScore = (score: number): number => (score - (score % XP_FACTOR)) / XP_FACTOR;

/** KST 날짜(YYYY-MM-DD)가 속한 기간의 키: 주간은 그 주 월요일, 월간은 YYYY-MM, 전체는 all */
export function periodKey(period: RankPeriod, kstDate: string): string {
  if (period === 'ALL') return 'all';
  if (period === 'MONTHLY') return kstDate.slice(0, 7);
  const day = Temporal.PlainDate.from(kstDate);
  return day.subtract({ days: day.dayOfWeek - 1 }).toString();
}

export type RankMember = { role: string; grade: number | null; classNo: number | null };

/** 교사는 랭킹에 넣지 않는다. 학년·반이 없으면 학교 범위에만 들어간다 */
export function scopeKeys(member: RankMember): string[] {
  if (member.role !== 'STUDENT') return [];
  const keys = ['school'];
  if (member.grade !== null) {
    keys.push(`grade:${member.grade}`);
    if (member.classNo !== null) keys.push(`class:${member.grade}-${member.classNo}`);
  }
  return keys;
}

export const rankKey = (period: RankPeriod, kstDate: string, scope: string): string =>
  `rank:${period.toLowerCase()}:${periodKey(period, kstDate)}:${scope}`;

/** 지난 기간 키는 시즌 스냅샷이 남은 뒤 메모리를 비우도록 만료시킨다 (전체 기간은 만료 없음) */
export const RANK_KEY_TTL_SECONDS: Record<RankPeriod, number | null> = {
  WEEKLY: 60 * 24 * 60 * 60,
  MONTHLY: 400 * 24 * 60 * 60,
  ALL: null,
};
