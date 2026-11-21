import { describe, expect, it } from 'vitest';
import { scorePractice } from './practice-scoring.js';

const question = (index: number, wordId = `w${index}`) => ({
  index,
  wordId,
  prompt: `p${index}`,
  choices: ['a', 'b', 'c', 'd'],
  answerIndex: 1,
});

describe('scorePractice', () => {
  it('정답은 남은 시간 비례 점수, 오답·시간 초과·미제출은 0점이고 오답노트로', () => {
    const questions = [question(0), question(1), question(2), question(3), question(4)];
    const result = scorePractice(
      questions,
      [
        { index: 0, choiceIndex: 1, elapsedMs: 0 },
        { index: 1, choiceIndex: 1, elapsedMs: 5000 },
        { index: 2, choiceIndex: 0, elapsedMs: 1000 },
        { index: 3, choiceIndex: 1, elapsedMs: 10_001 },
      ],
      10_000,
    );
    expect(result).toEqual({ score: 150 + 125, correctCount: 2, wrongWordIds: ['w2', 'w3', 'w4'] });
  });

  it('같은 단어가 여러 번 틀려도 오답노트에는 한 번', () => {
    const result = scorePractice(
      [question(0, 'same'), question(1, 'same')],
      [{ index: 0, choiceIndex: null, elapsedMs: 0 }],
      5000,
    );
    expect(result).toEqual({ score: 0, correctCount: 0, wrongWordIds: ['same'] });
  });
});
