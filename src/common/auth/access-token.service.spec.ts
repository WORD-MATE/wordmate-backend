import { generateKeyPairSync } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../config/env.js';
import { AppException } from '../errors/app-exception.js';
import { AccessTokenService } from './access-token.service.js';
import type { AuthUser } from './auth-user.js';

const pem = (type: 'ed25519' | 'rsa') =>
  (type === 'rsa'
    ? generateKeyPairSync('rsa', { modulusLength: 2048 })
    : generateKeyPairSync('ed25519')
  ).privateKey
    .export({ type: 'pkcs8', format: 'pem' })
    .toString();

const configOf = (values: Partial<Record<keyof Env, unknown>>) =>
  ({ get: (key: keyof Env) => values[key] }) as unknown as ConfigService<Env, true>;

const key = pem('ed25519');
const service = new AccessTokenService(configOf({ JWT_PRIVATE_KEY: key, JWT_KEY_ID: 'k1' }));
const user: AuthUser = { userId: 'u1', role: 'STUDENT', isAdmin: false, deviceId: 'd1' };

const codeOf = async (promise: Promise<unknown>) =>
  ((await promise.catch((e: unknown) => e)) as AppException).code;

describe('AccessTokenService', () => {
  it('발급한 토큰을 같은 사용자 정보로 검증한다', async () => {
    expect(await service.verify(await service.sign(user))).toEqual(user);
  });

  it('만료된 토큰은 AUTH_TOKEN_EXPIRED', async () => {
    const { createPrivateKey } = await import('node:crypto');
    const expired = await new SignJWT({ role: 'STUDENT', adm: false, sid: 'd1' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'k1' })
      .setSubject('u1')
      .setIssuer('wordmate')
      .setAudience('wordmate-api')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(createPrivateKey(key));
    expect(await codeOf(service.verify(expired))).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('다른 키로 서명했거나 변조된 토큰은 AUTH_INVALID', async () => {
    const other = new AccessTokenService(
      configOf({ JWT_PRIVATE_KEY: pem('ed25519'), JWT_KEY_ID: 'k1' }),
    );
    expect(await codeOf(service.verify(await other.sign(user)))).toBe('AUTH_INVALID');

    const token = await service.sign(user);
    expect(await codeOf(service.verify(`${token.slice(0, -2)}xx`))).toBe('AUTH_INVALID');
    expect(await codeOf(service.verify('not-a-jwt'))).toBe('AUTH_INVALID');
  });

  it('kid가 다르면 AUTH_INVALID', async () => {
    const rotated = new AccessTokenService(configOf({ JWT_PRIVATE_KEY: key, JWT_KEY_ID: 'k2' }));
    expect(await codeOf(service.verify(await rotated.sign(user)))).toBe('AUTH_INVALID');
  });

  it('Ed25519가 아닌 키는 시작할 때 거부한다', () => {
    expect(
      () => new AccessTokenService(configOf({ JWT_PRIVATE_KEY: pem('rsa'), JWT_KEY_ID: 'k1' })),
    ).toThrow(/Ed25519/);
  });
});
