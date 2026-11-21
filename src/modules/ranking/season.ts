import type { SeasonPeriod } from '../../common/enums.js';
import { periodKey } from './ranking-keys.js';

/** 서버가 꺼져 있던 동안 마감하지 못한 시즌도 따라잡도록 이만큼 지난 기간까지 본다 */
export const CATCH_UP: Record<SeasonPeriod, number> = { WEEKLY: 4, MONTHLY: 2 };

export type SeasonRange = {
  period: SeasonPeriod;
  periodKey: string;
  startsOn: string;
  endsOn: string;
};

/** 오늘(KST) 기준으로 이미 끝난 최근 기간들. 가까운 것부터 */
export function endedSeasons(period: SeasonPeriod, today: string): SeasonRange[] {
  const current = Temporal.PlainDate.from(
    period === 'WEEKLY' ? periodKey('WEEKLY', today) : `${periodKey('MONTHLY', today)}-01`,
  );
  const step = period === 'WEEKLY' ? { weeks: 1 } : { months: 1 };
  const result: SeasonRange[] = [];
  let end = current;
  for (let i = 0; i < CATCH_UP[period]; i++) {
    const start = end.subtract(step);
    result.push({
      period,
      periodKey: periodKey(period, start.toString()),
      startsOn: start.toString(),
      endsOn: end.toString(),
    });
    end = start;
  }
  return result;
}

/**
 * XP 내림차순으로 정렬된 참여자에게 순위를 매긴다. 순위는 목록에 보이는 사람끼리 세고,
 * 목록에 없는 사람(비공개 등)은 자기를 그 사이에 끼워 넣은 순위를 받는다
 */
export function snapshotRanks<T extends { listed: boolean }>(
  sorted: T[],
): (T & { rank: number })[] {
  let listedBefore = 0;
  return sorted.map((member) => {
    const rank = listedBefore + 1;
    if (member.listed) listedBefore++;
    return { ...member, rank };
  });
}
