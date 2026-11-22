import { describe, expect, it } from 'vitest';
import { isCorrectAnswer, morningDate } from './morning-rules.js';

describe('morningDate', () => {
  it('06:00 KST 전에는 전날', () => {
    expect(morningDate(new Date('2026-11-22T20:59:59.999Z'))).toBe('2026-11-22');
    expect(morningDate(new Date('2026-11-22T21:00:00Z'))).toBe('2026-11-23');
    expect(morningDate(new Date('2026-11-22T15:30:00Z'))).toBe('2026-11-22');
  });
});

describe('isCorrectAnswer', () => {
  it('앞뒤 공백·대소문자 무시', () => {
    expect(isCorrectAnswer(['Persistence'], '  persistence ')).toBe(true);
    expect(isCorrectAnswer(['a', 'b'], 'B')).toBe(true);
    expect(isCorrectAnswer(['persist'], 'persists')).toBe(false);
  });
});
