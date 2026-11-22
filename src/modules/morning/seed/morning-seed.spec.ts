import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MorningSeed } from './morning-seed.js';

const example = JSON.parse(readFileSync('seeds/morning.example.json', 'utf8'));

describe('MorningSeed', () => {
  it('예시 파일은 올바르다', () => {
    expect(MorningSeed.safeParse(example).success).toBe(true);
  });

  it('강조 위치가 문장 밖이거나 빈칸 정답이 문장에 없으면 거절', () => {
    const [sentence] = example.sentences;
    const outOfRange = structuredClone(sentence);
    outOfRange.keywords[0].highlight = { start: 0, end: 999 };
    const blank = structuredClone(sentence);
    blank.quizzes[0].answers = ['nowhere'];
    const choice = structuredClone(sentence);
    choice.quizzes[1].answers = ['없는 보기'];
    for (const bad of [outOfRange, blank, choice]) {
      expect(MorningSeed.safeParse({ sentences: [bad] }).success).toBe(false);
    }
    expect(MorningSeed.safeParse({ sentences: [sentence, sentence] }).success).toBe(false);
  });
});
