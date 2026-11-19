import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.js';

const required = {
  DATABASE_URL: 'mysql://user:pass@localhost:3306/wordmate',
  VALKEY_URL: 'redis://localhost:6379',
  JWT_PRIVATE_KEY: 'pem',
  DATAGSM_CLIENT_ID: 'client-1',
  DATAGSM_REDIRECT_URIS: 'wordmate://callback, http://localhost:5173/callback',
};

describe('validateEnv', () => {
  it('선택 값이 없으면 기본값을 채운다', () => {
    expect(validateEnv(required)).toMatchObject({
      NODE_ENV: 'development',
      HOST: '0.0.0.0',
      PORT: 3000,
      LOG_LEVEL: 'info',
      CORS_ORIGINS: [],
      DATAGSM_REDIRECT_URIS: ['wordmate://callback', 'http://localhost:5173/callback'],
      DATAGSM_AUTH_URL: 'https://oauth.authorization.datagsm.kr',
    });
  });

  it('TRUST_PROXY는 IP·CIDR 목록, SWAGGER_ENABLED는 문자열 불리언', () => {
    const env = validateEnv({
      ...required,
      TRUST_PROXY: '172.30.0.0/24, 10.0.0.1',
      SWAGGER_ENABLED: 'true',
    });
    expect(env).toMatchObject({
      TRUST_PROXY: ['172.30.0.0/24', '10.0.0.1'],
      SWAGGER_ENABLED: true,
    });
    const defaults = validateEnv(required);
    expect(defaults.TRUST_PROXY).toEqual([]);
    expect(defaults.SWAGGER_ENABLED).toBeUndefined();
    expect(() => validateEnv({ ...required, TRUST_PROXY: 'everyone' })).toThrow('TRUST_PROXY');
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
    expect(() => validateEnv({})).toThrow(
      /DATABASE_URL[\s\S]*VALKEY_URL[\s\S]*JWT_PRIVATE_KEY[\s\S]*DATAGSM_CLIENT_ID/,
    );
  });

  it('JWT_PRIVATE_KEY의 \\n 문자열을 실제 줄바꿈으로 바꾼다', () => {
    const env = validateEnv({ ...required, JWT_PRIVATE_KEY: String.raw`a\nb` });
    expect(env.JWT_PRIVATE_KEY).toBe('a\nb');
  });

  it('URL 프로토콜이 틀리면 에러를 던진다', () => {
    expect(() =>
      validateEnv({ ...required, DATABASE_URL: 'postgres://localhost/wordmate' }),
    ).toThrow(/DATABASE_URL/);
  });
});
