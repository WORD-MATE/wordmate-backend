import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Platform } from '../src/common/enums.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { devices } from '../src/infra/db/schema/index.js';
import { DataGsmClient, type DataGsmProfile } from '../src/modules/auth/datagsm/datagsm.client.js';
import { createTestApp, inject } from './support/create-test-app.js';
import { TEST_REDIRECT_URI } from './support/test-env.js';

const studentProfile = (): DataGsmProfile => ({
  datagsmId: randomUUID(),
  email: null,
  role: 'STUDENT',
  name: '기기학생',
  studentNumber: '1201',
  grade: 1,
  classNo: 2,
  number: 1,
  inactive: false,
  pending: false,
});

interface Session {
  accessToken: string;
  refreshToken: string;
  platform: Platform;
}

describe('기기 등록·목록·원격 로그아웃', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let profile = studentProfile();
  let loginCount = 0;

  // 로그인은 IP당 1분 10회 제한이라 요청마다 IP를 바꾼다
  const login = async (platform: Platform = 'IOS'): Promise<Session> => {
    const res = await inject(app, {
      method: 'POST',
      url: '/auth/datagsm',
      remoteAddress: `10.1.0.${++loginCount}`,
      headers: { 'x-client-platform': platform },
      payload: { code: 'c', codeVerifier: 'v'.repeat(43), redirectUri: TEST_REDIRECT_URI },
    });
    return { ...res.json(), platform };
  };

  const call = (
    session: Session,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    inject(app, {
      method,
      url,
      payload,
      headers: {
        authorization: `Bearer ${session.accessToken}`,
        'x-client-platform': session.platform,
      },
    });

  const register = (session: Session, payload: Record<string, unknown>) =>
    call(session, 'POST', '/devices', { deviceName: 'iPhone 17', ...payload });

  const deviceRow = async (deviceId: string) => {
    const [row] = await db.select().from(devices).where(eq(devices.id, deviceId));
    return row;
  };

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [
        [DataGsmClient, { exchangeCode: async () => 'at', getProfile: async () => profile }],
      ],
    });
    db = app.get(DB);
  });

  afterAll(async () => {
    await app.close();
  });

  it('현재 세션의 기기 이름·푸시 토큰을 등록하고 목록에 current로 보인다', async () => {
    const session = await login();
    const res = await register(session, { pushType: 'APNS', pushToken: 'apns-token-1' });
    expect(res.statusCode).toBe(200);
    const { deviceId } = res.json();

    const list = await call(session, 'GET', '/devices');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([
      {
        deviceId,
        platform: 'IOS',
        deviceName: 'iPhone 17',
        lastActiveAt: expect.any(String),
        current: true,
      },
    ]);
    expect(await deviceRow(deviceId)).toMatchObject({
      pushType: 'APNS',
      pushToken: 'apns-token-1',
    });

    await register(session, { pushType: null });
    expect(await deviceRow(deviceId)).toMatchObject({ pushType: null, pushToken: null });
  });

  it('pushType과 토큰이 맞지 않거나 플랫폼에서 쓸 수 없는 푸시면 400', async () => {
    const ios = await login();
    expect((await register(ios, { pushType: 'APNS' })).statusCode).toBe(400);
    expect((await register(ios, { pushType: null, pushToken: 'x' })).statusCode).toBe(400);
    const webOnIos = await register(ios, {
      pushType: 'WEBPUSH',
      webPushSubscription: {
        endpoint: 'https://push.example.com/a',
        keys: { p256dh: 'p', auth: 'a' },
      },
    });
    expect(webOnIos.statusCode).toBe(400);
    expect(webOnIos.json().code).toBe('INVALID_REQUEST');

    const android = await login('ANDROID');
    expect((await register(android, { pushType: 'APNS', pushToken: 't' })).statusCode).toBe(400);
    expect((await register(android, { pushType: 'FCM', pushToken: 'fcm-1' })).statusCode).toBe(200);
  });

  it('웹은 Web Push 구독 정보를 저장한다', async () => {
    const web = await login('WEB');
    const res = await call(web, 'POST', '/devices', {
      deviceName: 'Chrome · Windows',
      pushType: 'WEBPUSH',
      webPushSubscription: {
        endpoint: 'https://push.example.com/sub-1',
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(await deviceRow(res.json().deviceId)).toMatchObject({
      pushType: 'WEBPUSH',
      webPushEndpoint: 'https://push.example.com/sub-1',
      webPushP256dh: 'p256dh-key',
      webPushAuth: 'auth-key',
    });
  });

  it('같은 푸시 토큰을 다른 계정이 등록하면 기존 기기의 등록이 해제된다', async () => {
    const first = await login();
    const firstId = (await register(first, { pushType: 'FCM', pushToken: 'shared-token' })).json()
      .deviceId;

    profile = studentProfile();
    const second = await login();
    const res = await register(second, { pushType: 'FCM', pushToken: 'shared-token' });
    expect(res.statusCode).toBe(200);

    expect(await deviceRow(firstId)).toMatchObject({ pushType: null, pushToken: null });
    expect(await deviceRow(res.json().deviceId)).toMatchObject({ pushToken: 'shared-token' });
  });

  it('다른 기기를 원격 로그아웃하면 리프레시 토큰과 푸시 등록이 폐기된다', async () => {
    profile = studentProfile();
    const phone = await login();
    const tablet = await login();
    const tabletId = (
      await register(tablet, { pushType: 'APNS', pushToken: 'tablet-token' })
    ).json().deviceId;
    const phoneId = (await register(phone, { pushType: null })).json().deviceId;

    const list = (await call(phone, 'GET', '/devices')).json();
    expect(list).toHaveLength(2);
    expect(list.filter((d: { current: boolean }) => d.current)).toEqual([
      expect.objectContaining({ deviceId: phoneId }),
    ]);

    const current = await call(phone, 'DELETE', `/devices/${phoneId}`);
    expect(current.statusCode).toBe(400);
    expect(current.json().code).toBe('DEVICE_CURRENT');

    expect((await call(phone, 'DELETE', `/devices/${tabletId}`)).statusCode).toBe(204);
    expect(await deviceRow(tabletId)).toMatchObject({
      pushToken: null,
      revokedAt: expect.any(Date),
    });

    const refreshed = await inject(app, {
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: tablet.refreshToken },
    });
    expect(refreshed.json().code).toBe('AUTH_REFRESH_EXPIRED');
    expect((await register(tablet, { pushType: null })).statusCode).toBe(401);

    expect((await call(phone, 'GET', '/devices')).json()).toHaveLength(1);
    expect((await call(phone, 'DELETE', `/devices/${tabletId}`)).json().code).toBe(
      'DEVICE_NOT_FOUND',
    );
  });

  it('다른 사용자의 기기는 404, 형식이 틀린 ID는 400', async () => {
    profile = studentProfile();
    const other = await login();
    const otherId = (await register(other, { pushType: null })).json().deviceId;

    profile = studentProfile();
    const me = await login();
    const res = await call(me, 'DELETE', `/devices/${otherId}`);
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('DEVICE_NOT_FOUND');
    expect((await call(me, 'DELETE', '/devices/not-a-uuid')).statusCode).toBe(400);
  });
});
