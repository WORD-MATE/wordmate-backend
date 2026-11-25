import { describe, expect, it } from 'vitest';
import {
  answerXp,
  answerXpRate,
  blockedReasonOf,
  countAnswers,
  isPackComplete,
  nextStreak,
} from './study-result.js';

const a = (correct: boolean | null, counted = true, known: boolean | null = null) => ({
  correct,
  counted,
  known,
});

describe('countAnswers', () => {
  it('정답률은 소수 첫째 자리 반올림, 답이 없으면 null', () => {
    expect(countAnswers('CHOICE', [a(true), a(true), a(false)])).toEqual({
      correctCount: 2,
      wrongCount: 1,
      knownCount: null,
      unknownCount: null,
      accuracy: 66.7,
    });
    expect(countAnswers('TYPING', []).accuracy).toBeNull();
  });

  it('플래시카드는 알아요·몰라요만 세고 정답률은 null', () => {
    expect(
      countAnswers('FLASHCARD', [a(null, true, true), a(null, true, false), a(null, true, true)]),
    ).toEqual({ correctCount: 0, wrongCount: 0, knownCount: 2, unknownCount: 1, accuracy: null });
  });
});

describe('answerXp', () => {
  it('4지선다 1, 직접 입력 2, 오답노트 복습 1, 플래시카드 0, 너무 빠른 정답은 제외', () => {
    const answers = [a(true), a(true), a(false), a(true, false)];
    expect(answerXp('CHOICE', 'PACK', answers)).toEqual({ amount: 2, tooFast: true });
    expect(answerXp('TYPING', 'FAVORITE', answers)).toEqual({ amount: 4, tooFast: true });
    expect(answerXp('TYPING', 'WRONG_NOTE', answers.slice(0, 2))).toEqual({
      amount: 2,
      tooFast: false,
    });
    expect(answerXp('FLASHCARD', 'PACK', [a(null, false, true)])).toEqual({
      amount: 0,
      tooFast: false,
    });
  });
});

describe('isPackComplete', () => {
  const full = {
    source: 'PACK' as const,
    mode: 'CHOICE' as const,
    coversPack: true,
    total: 10,
    answered: 10,
    reason: 'FINISHED' as const,
  };
  it('팩 전체를 4지선다·직접 입력으로 끝까지 풀어야 완주', () => {
    expect(isPackComplete(full)).toBe(true);
    expect(isPackComplete({ ...full, answered: 9 })).toBe(false);
    expect(isPackComplete({ ...full, coversPack: false })).toBe(false);
    expect(isPackComplete({ ...full, mode: 'FLASHCARD' })).toBe(false);
    expect(isPackComplete({ ...full, reason: 'QUIT' })).toBe(false);
    expect(isPackComplete({ ...full, source: 'FAVORITE' })).toBe(false);
  });
});

describe('blockedReasonOf', () => {
  it('상한 → 하루 1회 → 너무 빠름 → 그만두기 순', () => {
    const none = { capped: false, bonusRepeated: false, tooFast: false, quit: false };
    expect(blockedReasonOf(none)).toBeNull();
    expect(blockedReasonOf({ ...none, quit: true, tooFast: true })).toBe('TOO_FAST');
    expect(blockedReasonOf({ ...none, quit: true, bonusRepeated: true })).toBe('REPEAT_LIMIT');
    expect(blockedReasonOf({ capped: true, bonusRepeated: true, tooFast: true, quit: true })).toBe(
      'DAILY_CAP',
    );
  });
});

describe('nextStreak', () => {
  it('처음 1, 같은 날은 그대로, 다음 날 +1, 끊기면 1부터 (최고 기록 유지)', () => {
    const first = nextStreak(null, '2026-11-20');
    expect(first).toEqual({ current: 1, best: 1, lastDate: '2026-11-20', increased: true });
    expect(nextStreak(first, '2026-11-20')).toMatchObject({ current: 1, increased: false });
    const second = nextStreak(first, '2026-11-21');
    expect(second).toMatchObject({ current: 2, best: 2, increased: true });
    expect(nextStreak(second, '2026-11-25')).toMatchObject({ current: 1, best: 2 });
    // 월말·연말 경계
    expect(nextStreak({ current: 3, best: 3, lastDate: '2026-12-31' }, '2027-01-01').current).toBe(
      4,
    );
  });
});

describe('answerXpRate', () => {
  it('플래시카드는 0, 오답노트는 1, 그 밖에는 직접 입력 2·4지선다 1', () => {
    expect(answerXpRate('FLASHCARD', 'PACK')).toBe(0);
    expect(answerXpRate('TYPING', 'WRONG_NOTE')).toBe(1);
    expect(answerXpRate('CHOICE', 'WRONG_NOTE')).toBe(1);
    expect(answerXpRate('TYPING', 'PACK')).toBe(2);
    expect(answerXpRate('CHOICE', 'FAVORITE')).toBe(1);
  });
});
