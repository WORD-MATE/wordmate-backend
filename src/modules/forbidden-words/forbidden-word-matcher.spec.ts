import { describe, expect, it } from 'vitest';
import { ForbiddenWordMatcher, normalizeForMatch } from './forbidden-word-matcher.js';

describe('ForbiddenWordMatcher', () => {
  const matcher = new ForbiddenWordMatcher(['ass', '바보'], ['class', 'pass']);

  it('부분 일치로 찾는다', () => {
    expect(matcher.find('dumbass')).toBe('ass');
    expect(matcher.find('너는 바보야')).toBe('바보');
    expect(matcher.find('apple')).toBeNull();
  });

  it('대소문자·전각·공백·기호로 우회해도 찾는다', () => {
    expect(matcher.find('ASS')).toBe('ass');
    expect(matcher.find('ａｓｓ')).toBe('ass');
    expect(matcher.find('a s.s')).toBe('ass');
    expect(matcher.find('바-보')).toBe('바보');
  });

  it('허용 단어 안에 든 금칙어는 통과시킨다', () => {
    expect(matcher.find('My Class')).toBeNull();
    expect(matcher.find('password')).toBeNull();
    expect(matcher.find('class ass')).toBe('ass');
  });

  it('허용 단어를 지운 자리에서 앞뒤 글자가 이어져 새 금칙어가 생기지 않는다', () => {
    const m = new ForbiddenWordMatcher(['ab'], ['xyz']);
    expect(m.find('axyzb')).toBeNull();
  });

  it('정규화', () => {
    expect(normalizeForMatch(' Ａ b,C! ')).toBe('abc');
  });
});
