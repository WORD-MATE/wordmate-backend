import { describe, expect, it } from 'vitest';
import { compareVersions, isValidVersion } from './version.js';

describe('isValidVersion', () => {
  it('숫자 1~3자리 버전만 허용한다', () => {
    expect(['1', '1.2', '1.2.3', '10.0.12'].every(isValidVersion)).toBe(true);
    expect(['', 'v1.0', '1.2.3.4', '1.2-beta', '1..2'].some(isValidVersion)).toBe(false);
  });
});

describe('compareVersions', () => {
  it('자리별 숫자로 비교한다', () => {
    expect(compareVersions('1.10.0', '1.9.9')).toBe(1);
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('2.0.0', '10.0.0')).toBe(-1);
  });
});
