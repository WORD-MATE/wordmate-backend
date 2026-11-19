import { describe, expect, it } from 'vitest';
import { nextAvailableName } from './pack-share.service.js';

describe('nextAvailableName', () => {
  it('겹치지 않으면 그대로, 겹치면 (2)부터 붙인다 (대소문자 무시)', () => {
    expect(nextAvailableName('수능 필수', [])).toBe('수능 필수');
    expect(nextAvailableName('Words', ['words'])).toBe('Words (2)');
    expect(nextAvailableName('Words', ['words', 'Words (2)'])).toBe('Words (3)');
  });

  it('붙인 뒤 30자를 넘으면 원래 이름을 자른다', () => {
    const name = 'a'.repeat(30);
    const result = nextAvailableName(name, [name]);
    expect(result).toBe(`${'a'.repeat(26)} (2)`);
    expect(result).toHaveLength(30);
  });
});
