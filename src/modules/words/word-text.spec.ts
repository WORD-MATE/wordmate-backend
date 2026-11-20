import { describe, expect, it } from 'vitest';
import {
  containsPattern,
  englishKey,
  fulltextQuery,
  normalizeEnglish,
  parseLine,
  parseText,
} from './word-text.js';

describe('parseLine', () => {
  it('처음 나오는 구분자에서 영어와 뜻을 나누고, 뜻은 쉼표로 나눈다', () => {
    expect(parseLine('apple / 사과, 능금')).toEqual({
      english: 'apple',
      meanings: ['사과', '능금'],
      error: null,
    });
    expect(parseLine('run,달리다, 운영하다')).toEqual({
      english: 'run',
      meanings: ['달리다', '운영하다'],
      error: null,
    });
    expect(parseLine('look  up\t찾아보다/조회하다')).toEqual({
      english: 'look up',
      meanings: ['찾아보다/조회하다'],
      error: null,
    });
  });

  it('빈 뜻과 중복 뜻은 버린다', () => {
    expect(parseLine('cat / 고양이, , 고양이 ').meanings).toEqual(['고양이']);
  });

  it('오류 코드', () => {
    expect(parseLine('apple 사과').error).toBe('NO_SEPARATOR');
    expect(parseLine(' / 사과')).toMatchObject({ english: null, error: 'EMPTY_ENGLISH' });
    expect(parseLine('apple / , ')).toMatchObject({ english: 'apple', error: 'EMPTY_MEANING' });
    expect(parseLine(`${'a'.repeat(51)} / 뜻`).error).toBe('TOO_LONG');
    expect(parseLine(`a / ${'뜻'.repeat(101)}`).error).toBe('TOO_LONG');
    expect(parseLine('a / 1,2,3,4,5,6').error).toBe('TOO_MANY_MEANINGS');
  });
});

describe('parseText', () => {
  it('BOM과 빈 줄을 건너뛰고 원래 줄 번호를 유지한다', () => {
    const rows = parseText('﻿apple / 사과\r\n\r\n  \nbanana / 바나나');
    expect(rows.map((row) => [row.line, row.english])).toEqual([
      [1, 'apple'],
      [4, 'banana'],
    ]);
  });
});

describe('englishKey', () => {
  it('대소문자·공백·전각을 맞춘다', () => {
    expect(englishKey('  Look   UP ')).toBe('look up');
    expect(englishKey('ＡＢＣ')).toBe('abc');
    expect(normalizeEnglish('Café')).toBe('Café');
  });
});

describe('검색어', () => {
  it('FULLTEXT는 2글자 이상인 낱말마다 구문 검색을 걸고, 없으면 null', () => {
    expect(fulltextQuery('give up')).toBe('+"give" +"up"');
    expect(fulltextQuery('사과')).toBe('+"사과"');
    expect(fulltextQuery('a b')).toBeNull();
    expect(fulltextQuery('a book')).toBe('+"book"');
    expect(fulltextQuery('"ab"c')).toBe('+"abc"');
  });

  it('LIKE 패턴은 와일드카드 문자를 글자 그대로 찾는다', () => {
    expect(containsPattern('app')).toBe('%app%');
    expect(containsPattern('50%_\\')).toBe('%50\\%\\_\\\\%');
  });
});
