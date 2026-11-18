import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { errors, jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { ROLE } from '../enums.js';
import { AuthErrors } from './auth-errors.js';
import type { AuthUser } from './auth-user.js';

export const ACCESS_TOKEN_TTL_SECONDS = 30 * 60;
const ISSUER = 'wordmate';
const AUDIENCE = 'wordmate-api';

const Claims = z.object({
  sub: z.string(),
  role: z.enum(ROLE),
  adm: z.boolean(),
  sid: z.string(),
});

@Injectable()
export class AccessTokenService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly keyId: string;

  constructor(config: ConfigService<Env, true>) {
    this.privateKey = createPrivateKey(config.get('JWT_PRIVATE_KEY', { infer: true }));
    if (this.privateKey.asymmetricKeyType !== 'ed25519') {
      throw new Error('JWT_PRIVATE_KEY는 Ed25519 개인키(PKCS#8 PEM)여야 합니다.');
    }
    this.publicKey = createPublicKey(this.privateKey);
    this.keyId = config.get('JWT_KEY_ID', { infer: true });
  }

  sign(user: AuthUser): Promise<string> {
    return new SignJWT({ role: user.role, adm: user.isAdmin, sid: user.deviceId })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.keyId })
      .setSubject(user.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.privateKey);
  }

  async verify(token: string): Promise<AuthUser> {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.publicKey, {
        algorithms: ['EdDSA'],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      if (protectedHeader.kid !== this.keyId) throw AuthErrors.invalidToken();
      const claims = Claims.parse(payload);
      return { userId: claims.sub, role: claims.role, isAdmin: claims.adm, deviceId: claims.sid };
    } catch (error) {
      if (error instanceof errors.JWTExpired) throw AuthErrors.tokenExpired();
      throw AuthErrors.invalidToken();
    }
  }
}
