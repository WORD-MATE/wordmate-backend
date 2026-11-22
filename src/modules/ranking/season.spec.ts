import { describe, expect, it } from 'vitest';
import { endedSeasons, snapshotRanks } from './season.js';

describe('endedSeasons', () => {
  it('주간: 이번 주 월요일 전의 4주, 가까운 것부터', () => {
    expect(endedSeasons('WEEKLY', '2026-11-20')).toEqual([
      { period: 'WEEKLY', periodKey: '2026-11-09', startsOn: '2026-11-09', endsOn: '2026-11-16' },
      { period: 'WEEKLY', periodKey: '2026-11-02', startsOn: '2026-11-02', endsOn: '2026-11-09' },
      { period: 'WEEKLY', periodKey: '2026-10-26', startsOn: '2026-10-26', endsOn: '2026-11-02' },
      { period: 'WEEKLY', periodKey: '2026-10-19', startsOn: '2026-10-19', endsOn: '2026-10-26' },
    ]);
    // 월요일 당일이면 바로 전 주가 막 끝난 시즌
    expect(endedSeasons('WEEKLY', '2026-11-16')[0]?.periodKey).toBe('2026-11-09');
  });

  it('월간: 지난 2달, 연말을 넘어간다', () => {
    expect(endedSeasons('MONTHLY', '2026-01-01')).toEqual([
      { period: 'MONTHLY', periodKey: '2025-12', startsOn: '2025-12-01', endsOn: '2026-01-01' },
      { period: 'MONTHLY', periodKey: '2025-11', startsOn: '2025-11-01', endsOn: '2025-12-01' },
    ]);
  });
});

describe('snapshotRanks', () => {
  it('목록에 보이는 사람끼리 순위를 매기고, 안 보이는 사람은 끼워 넣은 순위', () => {
    const ranked = snapshotRanks([
      { userId: 'hidden-top', listed: false },
      { userId: 'a', listed: true },
      { userId: 'b', listed: true },
      { userId: 'hidden-mid', listed: false },
      { userId: 'c', listed: true },
    ]);
    expect(ranked.map((m) => [m.userId, m.rank])).toEqual([
      ['hidden-top', 1],
      ['a', 1],
      ['b', 2],
      ['hidden-mid', 3],
      ['c', 3],
    ]);
  });
});

describe('snapshotRanks 제외', () => {
  const members = [
    { userId: 'a', listed: true },
    { userId: 'hidden', listed: false },
    { userId: 'b', listed: true },
    { userId: 'c', listed: true },
    { userId: 'd', listed: true },
  ];

  it('제외된 사람은 순위가 없고 아래 사람들이 한 칸씩 올라온다', () => {
    const ranked = snapshotRanks(members, new Set(['a', 'c']));
    expect(ranked.map((m) => [m.userId, m.rank])).toEqual([
      ['a', null],
      ['hidden', 1],
      ['b', 1],
      ['c', null],
      ['d', 2],
    ]);
  });

  it('제외를 풀면 마감 때 순위로 돌아온다', () => {
    const excluded = snapshotRanks(members, new Set(['b']));
    const restored = snapshotRanks(
      excluded.map((m) => ({ userId: m.userId, listed: m.listed })),
      new Set(),
    );
    expect(restored.map((m) => m.rank)).toEqual(snapshotRanks(members).map((m) => m.rank));
    expect(restored.map((m) => m.rank)).toEqual([1, 2, 2, 3, 4]);
  });

  it('비공개 사용자를 제외해도 다른 사람 순위는 그대로', () => {
    const ranked = snapshotRanks(members, new Set(['hidden']));
    expect(ranked.map((m) => m.rank)).toEqual([1, null, 2, 3, 4]);
  });
});
