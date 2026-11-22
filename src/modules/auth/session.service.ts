import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { AuthErrors } from '../../common/auth/auth-errors.js';
import type { Platform } from '../../common/enums.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { devices, refreshTokens } from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const CLEARED_PUSH = {
  pushType: null,
  pushToken: null,
  webPushEndpoint: null,
  webPushP256dh: null,
  webPushAuth: null,
} as const;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export interface Session {
  userId: string;
  deviceId: string;
  refreshToken: string;
}

type Executor = Pick<Database, 'insert'>;

@Injectable()
export class SessionService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async create(userId: string, platform: Platform): Promise<Session> {
    const deviceId = newId();
    const now = new Date();
    return this.db.transaction(async (tx) => {
      await tx.insert(devices).values({ id: deviceId, userId, platform, lastUsedAt: now });
      const refreshToken = await this.issue(tx, deviceId, now);
      return { userId, deviceId, refreshToken };
    });
  }

  async rotate(refreshToken: string): Promise<Session> {
    const now = new Date();
    const result = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ token: refreshTokens, device: devices })
        .from(refreshTokens)
        .innerJoin(devices, eq(devices.id, refreshTokens.deviceId))
        .where(eq(refreshTokens.tokenHash, hash(refreshToken)))
        .for('update');

      if (!row || row.device.revokedAt) return { kind: 'expired' } as const;
      if (row.token.usedAt) {
        await tx
          .update(devices)
          .set({ revokedAt: now, ...CLEARED_PUSH })
          .where(eq(devices.id, row.device.id));
        return { kind: 'reused' } as const;
      }
      if (row.token.expiresAt <= now) return { kind: 'expired' } as const;

      await tx.update(refreshTokens).set({ usedAt: now }).where(eq(refreshTokens.id, row.token.id));
      await tx.update(devices).set({ lastUsedAt: now }).where(eq(devices.id, row.device.id));
      const next = await this.issue(tx, row.device.id, now);
      return {
        kind: 'rotated',
        session: { userId: row.device.userId, deviceId: row.device.id, refreshToken: next },
      } as const;
    });

    if (result.kind === 'reused') throw AuthErrors.refreshReused();
    if (result.kind === 'expired') throw AuthErrors.refreshExpired();
    return result.session;
  }

  async revokeByRefreshToken(refreshToken: string): Promise<void> {
    const [token] = await this.db
      .select({ deviceId: refreshTokens.deviceId })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hash(refreshToken)));
    if (token) await this.revoke(token.deviceId);
  }

  /** 정지할 때 그 사용자의 모든 기기에서 로그아웃한다 */
  async revokeAll(userId: string): Promise<number> {
    const [result] = await this.db
      .update(devices)
      .set({ revokedAt: new Date(), ...CLEARED_PUSH })
      .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
    return result.affectedRows;
  }

  async revoke(deviceId: string): Promise<void> {
    await this.db
      .update(devices)
      .set({ revokedAt: new Date(), ...CLEARED_PUSH })
      .where(and(eq(devices.id, deviceId), isNull(devices.revokedAt)));
  }

  private async issue(tx: Executor, deviceId: string, now: Date): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await tx.insert(refreshTokens).values({
      deviceId,
      tokenHash: hash(token),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    });
    return token;
  }
}
