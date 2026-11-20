import { describe, expect, it } from 'vitest';
import { gradeTyping, nextProgress, normalizeTyped, type ProgressState } from './grading.js';

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
