import { describe, expect, it } from 'vitest';
import type { QuizWord } from '../study/question-builder.js';
import { challengeDeadline, pickChallengeQuestions, scoreChallenge } from './challenge-rules.js';

const word = (n: number, packId = 'p', meanings = [`뜻${n}`]): QuizWord => ({
  id: `w${n}`,
  packId,
  english: `word${n}`,
  meanings,
  derivatives: [],
});

describe('pickChallengeQuestions', () => {
  it('후보 순서대로 그 단어의 팩에서 보기를 만들고, 같은 영어 단어는 한 번만', () => {
    const pack = Array.from({ length: 12 }, (_, i) => word(i));
    const candidates = [pack[0], { ...pack[1], id: 'dup', english: 'WORD0' }, ...pack.slice(1)];
    const questions = pickChallengeQuestions(candidates as QuizWord[], () => pack, 10, 'KO_TO_EN');
    expect(questions?.map((q) => q.wordId)).toEqual(pack.slice(0, 10).map((w) => w.id));
    expect(questions?.map((q) => q.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const q of questions ?? []) {
      expect(q.choices).toHaveLength(4);
      expect(q.choices[q.answerIndex]).toBe(pack.find((w) => w.id === q.wordId)?.english);
    }
  });

  it('보기를 만들 수 없는 단어는 건너뛰고, 모자라면 null', () => {
    const tiny = [word(0, 'tiny'), word(1, 'tiny')];
    const big = Array.from({ length: 10 }, (_, i) => word(10 + i, 'big'));
    const poolOf = (packId: string) => (packId === 'tiny' ? tiny : big);
    const questions = pickChallengeQuestions([...tiny, ...big], poolOf, 10, 'EN_TO_KO');
    expect(questions?.every((q) => q.packId === 'big')).toBe(true);
    expect(pickChallengeQuestions([...tiny, ...big], poolOf, 11, 'EN_TO_KO')).toBeNull();
  });
});

describe('scoreChallenge', () => {
  const questions = [0, 1, 2].map((i) => ({
    index: i,
    wordId: `w${i}`,
    packId: 'p',
    prompt: `p${i}`,
    choices: ['a', 'b', 'c', 'd'],
    answerIndex: 2,
  }));
  const answers = [
    { index: 0, choiceIndex: 2, elapsedMs: 0 },
    { index: 1, choiceIndex: 1, elapsedMs: 0 },
    { index: 2, choiceIndex: 2, elapsedMs: 10_001 },
  ];

  it('제한 시간 안의 정답만 점수, 문항별 정답 번호를 돌려준다', () => {
    expect(scoreChallenge(questions, answers, 10_000, true)).toEqual({
      score: 150,
      correctCount: 1,
      results: [
        { index: 0, correct: true, answerIndex: 2 },
        { index: 1, correct: false, answerIndex: 2 },
        { index: 2, correct: false, answerIndex: 2 },
      ],
    });
  });

  it('마감이 지나 끝냈으면 모두 미응답', () => {
    const late = scoreChallenge(questions, answers, 10_000, false);
    expect(late).toMatchObject({ score: 0, correctCount: 0 });
    expect(late.results.every((r) => !r.correct)).toBe(true);
  });

  it('마감 = 시작 + 문항 수 × (제한 시간 + 1초) + 10초', () => {
    expect(challengeDeadline(new Date(0), 10, 10).getTime()).toBe(10 * 11_000 + 10_000);
  });
});
