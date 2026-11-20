import { describe, expect, it } from 'vitest';
import { buildQuestion, pickDistractors, type QuizWord, shuffled } from './question-builder.js';

const word = (id: string, english: string, meanings: string[], packId = 'p1'): QuizWord => ({
  id,
  packId,
  english,
  meanings,
  derivatives: [],
});

const apple = word('1', 'apple', ['사과', '능금']);
const pack = [
  apple,
  word('2', 'banana', ['바나나']),
  word('3', 'cherry', ['체리']),
  word('4', 'grape', ['포도']),
];
const first = () => 0;

describe('buildQuestion', () => {
  it('FLASHCARD는 카드 뒷면을, TYPING은 서버용 정답만 둔다', () => {
    expect(buildQuestion(apple, 0, 'FLASHCARD', 'EN_TO_KO', [])).toMatchObject({
      questionType: null,
      prompt: 'apple',
      card: { english: 'apple', meanings: ['사과', '능금'] },
      choices: null,
      acceptedAnswers: null,
    });
    expect(buildQuestion(apple, 3, 'TYPING', 'KO_TO_EN', [])).toMatchObject({
      idx: 3,
      questionType: 'KO_TO_EN_TYPING',
      prompt: '사과, 능금',
      acceptedAnswers: ['apple'],
      choices: null,
    });
    expect(buildQuestion(apple, 0, 'TYPING', 'EN_TO_KO', [])?.acceptedAnswers).toEqual([
      '사과',
      '능금',
    ]);
  });

  it('CHOICE는 보기 4개 중 answerIndex 자리에 정답 (EN_TO_KO는 대표 뜻)', () => {
    const question = buildQuestion(apple, 0, 'CHOICE', 'EN_TO_KO', [pack]);
    expect(question?.questionType).toBe('EN_TO_KO_CHOICE');
    expect(question?.choices).toHaveLength(4);
    expect(question?.choices?.[question.answerIndex as number]).toBe('사과');
    expect(new Set(question?.choices)).toEqual(new Set(['사과', '바나나', '체리', '포도']));

    const reverse = buildQuestion(apple, 0, 'CHOICE', 'KO_TO_EN', [pack]);
    expect(reverse?.choices?.[reverse.answerIndex as number]).toBe('apple');
  });

  it('보기가 모자라면 null', () => {
    expect(buildQuestion(apple, 0, 'CHOICE', 'EN_TO_KO', [pack.slice(0, 3)])).toBeNull();
  });
});

describe('pickDistractors', () => {
  it('보이는 글자가 정답·다른 보기와 같은 단어는 뺀다 (대소문자 무시)', () => {
    const pool = [...pack, word('5', 'Banana', ['바나나']), word('6', 'APPLE', ['사과'])];
    for (let i = 0; i < 20; i++) {
      const picked = pickDistractors(apple, 'KO_TO_EN', [pool]) ?? [];
      expect(picked).toHaveLength(3);
      expect(new Set(picked.map((text) => text.toLowerCase())).size).toBe(3);
      expect(picked.map((text) => text.toLowerCase())).not.toContain('apple');
    }
    // 뜻이 하나라도 겹치면 둘 다 정답이 되므로 뺀다 (보이는 글자가 달라도)
    const synonyms = [
      ...pack,
      word('9', 'large', ['큰', '능금']),
      word('10', 'huge', ['거대한', '사과']),
    ];
    for (const direction of ['EN_TO_KO', 'KO_TO_EN'] as const) {
      for (let i = 0; i < 20; i++) {
        const picked = pickDistractors(apple, direction, [synonyms]) ?? [];
        expect(picked).not.toContain('large');
        expect(picked).not.toContain('huge');
        expect(picked).not.toContain('큰');
        expect(picked).not.toContain('거대한');
      }
    }
    // 같은 뜻만 있으면 만들 수 없다
    const sameMeaning = [apple, ...['2', '3', '4'].map((id) => word(id, `w${id}`, ['사과']))];
    expect(pickDistractors(apple, 'EN_TO_KO', [sameMeaning], first)).toBeNull();
  });

  it('첫 pool이 모자라면 다음 pool에서 채운다', () => {
    const small = [apple, word('2', 'banana', ['바나나'])];
    const others = [word('7', 'kiwi', ['키위'], 'p2'), word('8', 'lemon', ['레몬'], 'p2')];
    expect(pickDistractors(apple, 'KO_TO_EN', [small, others], first)?.sort()).toEqual([
      'banana',
      'kiwi',
      'lemon',
    ]);
  });
});

describe('shuffled', () => {
  it('원본을 바꾸지 않고 같은 원소를 돌려준다', () => {
    const items = [1, 2, 3, 4, 5];
    const result = shuffled(items);
    expect(items).toEqual([1, 2, 3, 4, 5]);
    expect([...result].sort()).toEqual(items);
  });
});
