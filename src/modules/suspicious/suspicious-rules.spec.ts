import { describe, expect, it } from 'vitest';
import {
  capStreak,
  FAST_ANSWER_MIN_COUNT,
  FAST_ANSWER_RATIO,
  fastAnswerEvidence,
  REPEATED_OPPONENT_MIN,
  repeatedOpponentEvidence,
  XP_SPIKE_CAP_DAYS,
  XP_SPIKE_LOOKBACK_DAYS,
  xpSpikeEvidence,
} from './suspicious-rules.js';

const CAP = 500;

describe('빠른 답', () => {
  it('답이 적으면 비율이 높아도 표시하지 않는다', () => {
    expect(fastAnswerEvidence(FAST_ANSWER_MIN_COUNT - 1, FAST_ANSWER_MIN_COUNT - 1)).toBeNull();
  });

  it('비율이 기준 이상이면 근거 수치와 함께 표시한다', () => {
    const fast = Math.ceil(FAST_ANSWER_MIN_COUNT * FAST_ANSWER_RATIO);
    expect(fastAnswerEvidence(FAST_ANSWER_MIN_COUNT, fast)).toEqual({
      answerCount: FAST_ANSWER_MIN_COUNT,
      fastCount: fast,
      fastRatio: Math.round((fast / FAST_ANSWER_MIN_COUNT) * 1000) / 1000,
    });
    expect(fastAnswerEvidence(FAST_ANSWER_MIN_COUNT, fast - 1)).toBeNull();
  });
});

describe('같은 상대와 반복 대결', () => {
  it('기준 이상인 상대만 많은 순으로', () => {
    expect(
      repeatedOpponentEvidence([
        { opponentId: 'a', count: REPEATED_OPPONENT_MIN - 1 },
        { opponentId: 'b', count: REPEATED_OPPONENT_MIN },
        { opponentId: 'c', count: REPEATED_OPPONENT_MIN + 2 },
      ]),
    ).toEqual({
      opponents: [
        { userId: 'c', battleCount: REPEATED_OPPONENT_MIN + 2 },
        { userId: 'b', battleCount: REPEATED_OPPONENT_MIN },
      ],
    });
    expect(repeatedOpponentEvidence([{ opponentId: 'a', count: 1 }])).toBeNull();
  });
});

describe('XP 상한 연속', () => {
  const days = (xps: number[]) =>
    new Map(xps.map((xp, i) => [`2026-01-${String(20 - i).padStart(2, '0')}`, xp]));

  it('그날부터 거꾸로 상한을 채운 날을 센다', () => {
    expect(capStreak(days([CAP, CAP, CAP - 1, CAP]), '2026-01-20', CAP)).toBe(2);
    expect(capStreak(days([CAP - 1, CAP]), '2026-01-20', CAP)).toBe(0);
    expect(capStreak(days(Array(10).fill(CAP)), '2026-01-20', CAP)).toBe(XP_SPIKE_LOOKBACK_DAYS);
  });

  it('기준 일수 이상 이어지면 날짜별 XP와 함께 표시한다', () => {
    const xps = Array(XP_SPIKE_CAP_DAYS).fill(CAP);
    const evidence = xpSpikeEvidence(days(xps), '2026-01-20', CAP);
    expect(evidence?.capDays).toBe(XP_SPIKE_CAP_DAYS);
    expect(evidence?.daily[0]).toEqual({ date: '2026-01-20', xp: CAP });
    expect(xpSpikeEvidence(days(xps.slice(1)), '2026-01-20', CAP)).toBeNull();
  });
});
