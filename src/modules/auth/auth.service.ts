import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq } from 'drizzle-orm';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AccessTokenService,
} from '../../common/auth/access-token.service.js';
import { AuthErrors } from '../../common/auth/auth-errors.js';
import type { NextStep, Platform } from '../../common/enums.js';
import { CommonErrors } from '../../common/errors/app-exception.js';
import type { Env } from '../../config/env.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { type User, users } from '../../infra/db/schema/index.js';
import { type Me, toMe } from '../users/me.schema.js';
import { DataGsmClient, type DataGsmProfile } from './datagsm/datagsm.client.js';
import { SessionService } from './session.service.js';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface LoginResult extends IssuedTokens {
  nextStep: NextStep;
  user: Me;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly config: ConfigService<Env, true>,
    private readonly datagsm: DataGsmClient,
    private readonly sessions: SessionService,
    private readonly accessTokens: AccessTokenService,
  ) {}

  async loginWithDataGsm(
    input: { code: string; codeVerifier: string; redirectUri: string },
    platform: Platform,
  ): Promise<LoginResult> {
    if (!this.config.get('DATAGSM_REDIRECT_URIS', { infer: true }).includes(input.redirectUri)) {
      throw CommonErrors.invalidRequest(
        { field: 'redirectUri' },
        '허용되지 않은 redirectUri입니다.',
      );
    }

    const datagsmToken = await this.datagsm.exchangeCode(input);
    const profile = await this.datagsm.getProfile(datagsmToken);
    if (profile.pending) throw AuthErrors.accountInactive('DATAGSM_PENDING');

    const user = await this.syncUser(profile);
    const session = await this.sessions.create(user.id, platform);
    const accessToken = await this.signFor(user, session.deviceId);

    return {
      accessToken,
      refreshToken: session.refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      nextStep: this.nextStep(user),
      user: toMe(user),
    };
  }

  async refresh(refreshToken: string): Promise<IssuedTokens> {
    const session = await this.sessions.rotate(refreshToken);
    const [user] = await this.db.select().from(users).where(eq(users.id, session.userId));

    try {
      if (!user) throw AuthErrors.refreshExpired();
      this.assertActive(user);
    } catch (error) {
      await this.sessions.revoke(session.deviceId);
      throw error;
    }

    return {
      accessToken: await this.signFor(user, session.deviceId),
      refreshToken: session.refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  logout(refreshToken: string): Promise<void> {
    return this.sessions.revokeByRefreshToken(refreshToken);
  }

  private async syncUser(profile: DataGsmProfile): Promise<User> {
    const now = new Date();
    const fields = {
      email: profile.email,
      name: profile.name,
      role: profile.role,
      studentNumber: profile.studentNumber,
      grade: profile.grade,
      classNo: profile.classNo,
      number: profile.number,
      lastLoginAt: now,
    };

    const user = await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(users)
        .where(eq(users.datagsmId, profile.datagsmId))
        .for('update');

      if (!existing) {
        if (profile.inactive) return null;
        await tx.insert(users).values({ datagsmId: profile.datagsmId, ...fields });
      } else {
        await tx
          .update(users)
          .set({ ...fields, status: nextStatus(existing, profile, now) })
          .where(eq(users.id, existing.id));
      }
      const [saved] = await tx.select().from(users).where(eq(users.datagsmId, profile.datagsmId));
      return saved ?? null;
    });

    if (!user) throw AuthErrors.accountInactive('GRADUATED_OR_LEFT');
    this.assertActive(user);
    return user;
  }

  private assertActive(user: User): void {
    if (user.status === 'SUSPENDED') {
      throw AuthErrors.accountSuspended(user.suspendReason, user.suspendedUntil);
    }
    if (user.status === 'INACTIVE') throw AuthErrors.accountInactive('GRADUATED_OR_LEFT');
    if (user.status === 'WITHDRAWN') throw AuthErrors.refreshExpired();
  }

  private signFor(user: User, deviceId: string): Promise<string> {
    return this.accessTokens.sign({
      userId: user.id,
      role: user.role,
      isAdmin: user.isAdmin,
      deviceId,
    });
  }

  // 약관 동의·교사 담당 반 기능이 들어오면 TERMS_AGREEMENT, TEACHER_CLASS_SELECT를 판정한다
  private nextStep(_user: User): NextStep {
    return 'HOME';
  }
}

function nextStatus(existing: User, profile: DataGsmProfile, now: Date): User['status'] {
  if (profile.inactive) return 'INACTIVE';
  if (existing.status === 'INACTIVE') return 'ACTIVE';
  if (
    existing.status === 'SUSPENDED' &&
    existing.suspendedUntil &&
    existing.suspendedUntil <= now
  ) {
    return 'ACTIVE';
  }
  return existing.status;
}
