import { describe, expect, it } from 'vitest';
import type { QuizWord } from '../study/question-builder.js';
import { buildBattleQuestions, rankPlayers, scoreOf } from './battle-rules.js';

const word = (n: number, meanings = [`뜻${n}`]): QuizWord => ({
  id: `w${n}`,
  packId: 'p',
  english: `word${n}`,
  meanings,
  derivatives: [],
});

describe('buildBattleQuestions', () => {
  it('단어가 충분하면 중복 없이 문항 수만큼 내고, 보기 4개 중 정답이 answerIndex', () => {
    const words = Array.from({ length: 12 }, (_, i) => word(i));
    const questions = buildBattleQuestions(words, 10, 'KO_TO_EN') ?? [];
    expect(questions).toHaveLength(10);
    expect(new Set(questions.map((q) => q.wordId)).size).toBe(10);
    for (const q of questions) {
      const answer = words.find((w) => w.id === q.wordId) as QuizWord;
      expect(q.choices).toHaveLength(4);
      expect(q.choices[q.answerIndex]).toBe(answer.english);
      expect(q.prompt).toBe(answer.meanings.join(', '));
    }
  });

  it('단어가 모자라면 다시 섞어 중복 출제하고, 같은 단어가 연달아 나오지 않는다', () => {
    const words = Array.from({ length: 10 }, (_, i) => word(i));
    for (let run = 0; run < 20; run++) {
      const questions = buildBattleQuestions(words, 30, 'EN_TO_KO') ?? [];
      expect(questions).toHaveLength(30);
      expect(questions.map((q) => q.idx)).toEqual(Array.from({ length: 30 }, (_, i) => i));
      for (let i = 1; i < questions.length; i++) {
        expect(questions[i]?.wordId).not.toBe(questions[i - 1]?.wordId);
      }
    }
  });

  it('보기를 만들 수 없는 단어는 빼고, 하나도 없으면 null', () => {
    const same = Array.from({ length: 10 }, (_, i) => word(i, ['같은 뜻']));
    expect(buildBattleQuestions(same, 10, 'KO_TO_EN')).toBeNull();
    // 같은 뜻 단어끼리는 서로 오답 보기가 될 수 없어 보기를 2개밖에 못 고른다
    const mixed = [...same.slice(0, 8), word(100), word(101)];
    const questions = buildBattleQuestions(mixed, 10, 'KO_TO_EN') ?? [];
    expect(questions).toHaveLength(10);
    for (const q of questions) expect(['w100', 'w101']).toContain(q.wordId);
  });
});

describe('scoreOf', () => {
  it('정답은 100 + 남은 시간 비례 보너스(최대 50), 오답은 0', () => {
    expect(scoreOf(true, 10_000, 10_000)).toBe(150);
    expect(scoreOf(true, 5_000, 10_000)).toBe(125);
    expect(scoreOf(true, 0, 10_000)).toBe(100);
    expect(scoreOf(true, 333, 10_000)).toBe(102);
    expect(scoreOf(true, -5, 10_000)).toBe(100);
    expect(scoreOf(true, 20_000, 10_000)).toBe(150);
    expect(scoreOf(false, 9_000, 10_000)).toBe(0);
  });
});

describe('rankPlayers', () => {
  it('점수 높은 순, 같으면 총 풀이 시간 짧은 순, 둘 다 같으면 같은 순위', () => {
    const ranked = rankPlayers([
      { userId: 'a', score: 200, totalTimeMs: 9000 },
      { userId: 'b', score: 300, totalTimeMs: 9000 },
      { userId: 'c', score: 200, totalTimeMs: 5000 },
      { userId: 'd', score: 200, totalTimeMs: 5000 },
      { userId: 'e', score: 0, totalTimeMs: 20000 },
    ]);
    expect(ranked.map((p) => [p.userId, p.rank])).toEqual([
      ['b', 1],
      ['c', 2],
      ['d', 2],
      ['a', 4],
      ['e', 5],
    ]);
  });
});
