import { describe, expect, it } from 'vitest';
import { parseValkeyUrl } from './parse-valkey-url.js';

describe('parseValkeyUrl', () => {
  it('호스트만 있으면 기본 포트와 0번 DB를 쓴다', () => {
    expect(parseValkeyUrl('redis://localhost')).toEqual({ host: 'localhost', port: 6379, db: 0 });
  });

  it('인증 정보, 포트, DB 번호를 읽는다', () => {
    expect(parseValkeyUrl('redis://user:p%40ss@valkey:6380/2')).toEqual({
      host: 'valkey',
      port: 6380,
      username: 'user',
      password: 'p@ss',
      db: 2,
    });
  });

  it('rediss면 TLS를 켠다', () => {
    expect(parseValkeyUrl('rediss://valkey').tls).toEqual({});
  });
});
