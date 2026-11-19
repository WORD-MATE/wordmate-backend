import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, gt, isNull, ne } from 'drizzle-orm';
import { AuthErrors } from '../../common/auth/auth-errors.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import type { Platform, PushType } from '../../common/enums.js';
import { AppException, CommonErrors } from '../../common/errors/app-exception.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { devices } from '../../infra/db/schema/index.js';
import { CLEARED_PUSH, REFRESH_TOKEN_TTL_MS, SessionService } from '../auth/session.service.js';
import type { RegisterDevice } from './devices.schemas.js';

export const DeviceErrors = {
  current: () =>
    new AppException(
      'DEVICE_CURRENT',
      '현재 기기는 로그아웃 API를 사용해야 합니다.',
      HttpStatus.BAD_REQUEST,
    ),
  notFound: () =>
    new AppException('DEVICE_NOT_FOUND', '기기를 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
};

const ALLOWED_PUSH: Record<Platform, readonly PushType[]> = {
  IOS: ['APNS', 'FCM'],
  ANDROID: ['FCM'],
  WEB: ['WEBPUSH'],
};

const toPushColumns = (body: RegisterDevice) => {
  if (body.pushType === null) return CLEARED_PUSH;
  if (body.pushType === 'WEBPUSH') {
    const { endpoint, keys } = body.webPushSubscription;
    return {
      ...CLEARED_PUSH,
      pushType: body.pushType,
      webPushEndpoint: endpoint,
      webPushP256dh: keys.p256dh,
      webPushAuth: keys.auth,
    };
  }
  return { ...CLEARED_PUSH, pushType: body.pushType, pushToken: body.pushToken };
};

@Injectable()
export class DevicesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly sessions: SessionService,
  ) {}

  async register(user: AuthUser, platform: Platform, body: RegisterDevice) {
    if (body.pushType && !ALLOWED_PUSH[platform].includes(body.pushType)) {
      throw CommonErrors.invalidRequest(
        { platform, pushType: body.pushType },
        '이 플랫폼에서 쓸 수 없는 푸시 종류입니다.',
      );
    }
    const push = toPushColumns(body);

    await this.db.transaction(async (tx) => {
      const [device] = await tx
        .select({ revokedAt: devices.revokedAt })
        .from(devices)
        .where(and(eq(devices.id, user.deviceId), eq(devices.userId, user.userId)))
        .for('update');
      if (!device || device.revokedAt) throw AuthErrors.invalidToken();

      // 공용 기기에서 다른 계정이 쓰던 푸시 토큰이면 그쪽 등록을 해제해야 unique 제약에 걸리지 않는다
      if (push.pushToken) {
        await tx
          .update(devices)
          .set(CLEARED_PUSH)
          .where(and(eq(devices.pushToken, push.pushToken), ne(devices.id, user.deviceId)));
      }
      if (push.webPushEndpoint) {
        await tx
          .update(devices)
          .set(CLEARED_PUSH)
          .where(
            and(eq(devices.webPushEndpoint, push.webPushEndpoint), ne(devices.id, user.deviceId)),
          );
      }

      await tx
        .update(devices)
        .set({ name: body.deviceName, ...push, lastUsedAt: new Date() })
        .where(eq(devices.id, user.deviceId));
    });

    return { deviceId: user.deviceId };
  }

  async list(user: AuthUser) {
    const rows = await this.db
      .select({
        id: devices.id,
        platform: devices.platform,
        name: devices.name,
        lastUsedAt: devices.lastUsedAt,
      })
      .from(devices)
      .where(
        and(
          eq(devices.userId, user.userId),
          isNull(devices.revokedAt),
          gt(devices.lastUsedAt, new Date(Date.now() - REFRESH_TOKEN_TTL_MS)),
        ),
      )
      .orderBy(desc(devices.lastUsedAt));

    return rows.map((row) => ({
      deviceId: row.id,
      platform: row.platform,
      deviceName: row.name,
      lastActiveAt: row.lastUsedAt.toISOString(),
      current: row.id === user.deviceId,
    }));
  }

  async remove(user: AuthUser, deviceId: string): Promise<void> {
    if (deviceId === user.deviceId) throw DeviceErrors.current();
    const [device] = await this.db
      .select({ id: devices.id })
      .from(devices)
      .where(
        and(eq(devices.id, deviceId), eq(devices.userId, user.userId), isNull(devices.revokedAt)),
      );
    if (!device) throw DeviceErrors.notFound();
    await this.sessions.revoke(deviceId);
  }
}
