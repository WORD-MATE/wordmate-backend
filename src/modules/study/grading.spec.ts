import { describe, expect, it } from 'vitest';
import {
  gradeTyping,
  nextProgress,
  nextReview,
  normalizeTyped,
  type ProgressState,
} from './grading.js';

describe('gradeTyping', () => {
  it('KO_TO_EN: 공백·대소문자·전각을 정규화해 영어와 비교', () => {
    expect(gradeTyping('  Look   UP ', 'KO_TO_EN', ['look up'])).toBe(true);
    expect(gradeTyping('ＡＰＰＬＥ', 'KO_TO_EN', ['apple'])).toBe(true);
    expect(gradeTyping('lookup', 'KO_TO_EN', ['look up'])).toBe(false);
    expect(gradeTyping('apples', 'KO_TO_EN', ['apple'])).toBe(false);
  });

  it('EN_TO_KO: 띄어쓰기 무시, 뜻 중 하나와 같으면 정답', () => {
    expect(gradeTyping('포기 하다', 'EN_TO_KO', ['포기하다', '그만두다'])).toBe(true);
    expect(gradeTyping('그만두다', 'EN_TO_KO', ['포기하다', '그만두다'])).toBe(true);
    expect(gradeTyping('포기', 'EN_TO_KO', ['포기하다'])).toBe(false);
  });

  it('normalizeTyped', () => {
    expect(normalizeTyped('  A  b\tC ')).toBe('a b c');
  });
});

describe('nextProgress', () => {
  const correct = (sessionId: string, counted = true) => ({ correct: true, counted, sessionId });
  const wrong = (sessionId: string) => ({ correct: false, counted: true, sessionId });
  const run = (answers: ReturnType<typeof correct>[]) =>
    answers.reduce<ProgressState | null>((state, answer) => nextProgress(state, answer), null);

  it('처음 답하면 LEARNING, 서로 다른 학습에서 3번 연속 맞히면 MEMORIZED', () => {
    expect(run([wrong('s1')])).toMatchObject({ memoryStatus: 'LEARNING', totalWrong: 1 });
    expect(run([correct('s1'), correct('s2')])).toMatchObject({
      memoryStatus: 'LEARNING',
      correctStreak: 2,
    });
    expect(run([correct('s1'), correct('s2'), correct('s3')])).toMatchObject({
      memoryStatus: 'MEMORIZED',
      correctStreak: 3,
      totalCorrect: 3,
    });
  });

  it('한 학습에서 여러 번 맞혀도, 너무 빨리 맞혀도 연속 정답은 늘지 않는다', () => {
    expect(run([correct('s1'), correct('s1'), correct('s1')])).toMatchObject({
      memoryStatus: 'LEARNING',
      correctStreak: 1,
      totalCorrect: 3,
    });
    expect(run([correct('s1', false), correct('s2', false), correct('s3', false)])).toMatchObject({
      memoryStatus: 'LEARNING',
      correctStreak: 0,
    });
  });

  it('틀리면 연속 정답이 0이 되고 MEMORIZED에서 LEARNING으로', () => {
    const state = run([correct('s1'), correct('s2'), correct('s3'), wrong('s4')]);
    expect(state).toMatchObject({ memoryStatus: 'LEARNING', correctStreak: 0, totalWrong: 1 });
    // 같은 학습에서 틀린 뒤 다시 맞히면 다시 센다
    expect(nextProgress(state, correct('s4'))).toMatchObject({ correctStreak: 1 });
  });
});

describe('nextReview', () => {
  const day = '2026-11-20';
  const review = (correct: boolean, counted = true) => ({ correct, counted, isReview: true });
  const study = (correct: boolean) => ({ correct, counted: true, isReview: false });

  it('처음 답하면 다음 날, 복습에서 맞힐 때마다 1·3·7·14·30일 간격, 다 통과하면 빠진다', () => {
    let state = nextReview(null, study(true), day);
    expect(state).toEqual({ reviewStage: 0, nextReviewOn: '2026-11-21', lastReviewedOn: null });

    const expected = ['2026-11-24', '2026-12-01', '2026-12-15', '2027-01-14', null];
    for (const next of expected) {
      const reviewDay = state.nextReviewOn as string;
      state = nextReview(state, review(true), reviewDay);
      expect(state.nextReviewOn).toBe(next);
      expect(state.lastReviewedOn).toBe(reviewDay);
    }
    expect(state.reviewStage).toBe(5);
  });

  it('틀리면 어디서든 다음 날부터 다시 (일정에서 빠진 단어도)', () => {
    const done = { reviewStage: 5, nextReviewOn: null, lastReviewedOn: '2026-10-01' };
    expect(nextReview(done, study(false), day)).toEqual({
      reviewStage: 0,
      nextReviewOn: '2026-11-21',
      lastReviewedOn: '2026-10-01',
    });
    const mid = { reviewStage: 2, nextReviewOn: '2026-11-20', lastReviewedOn: null };
    expect(nextReview(mid, review(false), day)).toMatchObject({
      reviewStage: 0,
      nextReviewOn: '2026-11-21',
      lastReviewedOn: day,
    });
  });

  it('일정 필드만 돌려준다 (DB 행을 넘겨도 다른 컬럼이 섞이지 않음)', () => {
    const row = {
      memoryStatus: 'LEARNING',
      correctStreak: 2,
      reviewStage: 1,
      nextReviewOn: '2026-11-23',
      lastReviewedOn: null,
    };
    for (const answer of [study(true), study(false), review(true)]) {
      expect(Object.keys(nextReview(row, answer, day)).sort()).toEqual([
        'lastReviewedOn',
        'nextReviewOn',
        'reviewStage',
      ]);
    }
  });

  it('일반 학습 정답, 아직 날이 안 된 복습, 너무 빠른 정답은 일정을 바꾸지 않는다', () => {
    const waiting = { reviewStage: 1, nextReviewOn: '2026-11-23', lastReviewedOn: null };
    expect(nextReview(waiting, study(true), day)).toEqual(waiting);
    expect(nextReview(waiting, review(true), day)).toEqual({ ...waiting, lastReviewedOn: day });
    const due = { reviewStage: 1, nextReviewOn: '2026-11-19', lastReviewedOn: null };
    expect(nextReview(due, review(true, false), day)).toEqual({ ...due, lastReviewedOn: day });
  });
});
