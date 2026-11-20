import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DefaultPackSeed } from './default-pack-seed.js';

const word = (english: string, meanings = ['뜻']) => ({ english, meanings });

describe('DefaultPackSeed', () => {
  it('저장소의 예시 파일은 형식에 맞다', () => {
    const example = JSON.parse(readFileSync('seeds/default-packs.example.json', 'utf8'));
    expect(DefaultPackSeed.safeParse(example).success).toBe(true);
  });

  it('단어는 앱과 같은 규칙으로 정규화한다', () => {
    const seed = DefaultPackSeed.parse({
      packs: [{ name: ' 팩 ', words: [{ english: '  Look   up ', meanings: [' 찾아보다 '] }] }],
    });
    expect(seed.packs[0]).toMatchObject({
      name: '팩',
      sortOrder: 0,
      words: [{ english: 'Look up', meanings: ['찾아보다'] }],
    });
    expect(seed.categories).toEqual([]);
  });

  it('겹치는 이름·없는 분류·팩 안의 같은 단어(대소문자 무시)를 거절한다', () => {
    const result = DefaultPackSeed.safeParse({
      categories: [{ name: '수능' }, { name: '수능' }],
      packs: [
        { name: 'A', category: '토익', words: [word('apple'), word('APPLE')] },
        { name: 'A', words: [] },
      ],
    });
    expect(result.success).toBe(false);
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toEqual(
      expect.arrayContaining([
        '분류 이름이 겹칩니다: 수능',
        '단어팩 이름이 겹칩니다: A',
        'categories에 없는 분류입니다: 토익',
        '같은 단어가 두 번 있습니다: apple',
      ]),
    );
  });

  it('단어팩이 없거나 단어 한도를 넘으면 거절한다', () => {
    expect(DefaultPackSeed.safeParse({ packs: [] }).success).toBe(false);
    const tooMany = Array.from({ length: 1001 }, (_, i) => word(`w${i}`));
    expect(DefaultPackSeed.safeParse({ packs: [{ name: 'A', words: tooMany }] }).success).toBe(
      false,
    );
  });
});
