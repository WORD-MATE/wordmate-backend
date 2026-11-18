import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.js';

const required = {
  DATABASE_URL: 'mysql://user:pass@localhost:3306/wordmate',
  VALKEY_URL: 'redis://localhost:6379',
};

describe('validateEnv', () => {
  it('선택 값이 없으면 기본값을 채운다', () => {
    expect(validateEnv(required)).toEqual({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 3000,
      LOG_LEVEL: 'info',
      CORS_ORIGINS: [],
      ...required,
    });
  });

  it('문자열 PORT를 숫자로 바꾼다', () => {
    expect(validateEnv({ ...required, PORT: '8080' }).PORT).toBe(8080);
  });

  it('CORS_ORIGINS를 쉼표로 나눠 URL 목록으로 만든다', () => {
    expect(
      validateEnv({ ...required, CORS_ORIGINS: 'https://a.com, http://localhost:5173' })
        .CORS_ORIGINS,
    ).toEqual(['https://a.com', 'http://localhost:5173']);
    expect(() => validateEnv({ ...required, CORS_ORIGINS: 'not-a-url' })).toThrow(/CORS_ORIGINS/);
  });

  it('필수 값이 없으면 항목 이름을 담아 에러를 던진다', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL[\s\S]*VALKEY_URL/);
  });

  it('URL 프로토콜이 틀리면 에러를 던진다', () => {
    expect(() =>
      validateEnv({ ...required, DATABASE_URL: 'postgres://localhost/wordmate' }),
    ).toThrow(/DATABASE_URL/);
  });
});
