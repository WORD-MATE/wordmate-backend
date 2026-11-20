import { describe, expect, it } from 'vitest';
import { isDuplicateKeyError } from './errors.js';

describe('isDuplicateKeyError', () => {
  const mysqlError = Object.assign(
    new Error("Duplicate entry 'x' for key 'packs.packs_active_name_uq'"),
    {
      code: 'ER_DUP_ENTRY',
    },
  );

  it('drizzle이 감싼 에러의 cause까지 확인한다', () => {
    expect(isDuplicateKeyError(mysqlError)).toBe(true);
    expect(isDuplicateKeyError(new Error('Failed query', { cause: mysqlError }))).toBe(true);
  });

  it('인덱스 이름을 주면 그 인덱스 충돌만 인정한다', () => {
    expect(isDuplicateKeyError(mysqlError, 'packs_active_name_uq')).toBe(true);
    expect(isDuplicateKeyError(mysqlError, 'share_code_unique')).toBe(false);
  });

  it('다른 에러는 false', () => {
    expect(isDuplicateKeyError(new Error('boom'))).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });
});
