import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { devices, notifications, users } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { ApnsSender } from '../src/modules/push/apns.sender.js';
import { PushService } from '../src/modules/push/push.service.js';
import type { PushMessage } from '../src/modules/push/push-rules.js';
import { WebPushSender } from '../src/modules/push/webpush.sender.js';
import { createTestApp } from './support/create-test-app.js';

const kst = (time: string) => new Date(`2026-11-23T${time}:00+09:00`);
const NOON = kst('12:00');

describe('푸시 발송', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let push: PushService;
  const userIds: string[] = [];

  const makeUser = async () => {
    const userId = newId();
    userIds.push(userId);
    await db
      .insert(users)
      .values({ id: userId, name: '푸시', role: 'STUDENT', grade: 1, classNo: 1 });
    return userId;
  };

  const addDevice = async (userId: string, values: Partial<typeof devices.$inferInsert>) => {
    const id = newId();
    await db.insert(devices).values({
      id,
      userId,
      platform: 'IOS',
      lastUsedAt: new Date(),
      ...values,
    });
    return id;
  };

  const message = (type: PushMessage['type'] = 'NOTICE'): PushMessage => ({
    notificationId: newId(),
    type,
    title: '제목',
    body: '본문',
    route: '/notices',
  });

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    push = app.get(PushService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await db.delete(notifications).where(inArray(notifications.userId, userIds));
    await db.delete(devices).where(inArray(devices.userId, userIds));
    await app.close();
  });

  it('푸시를 등록한 쓰는 기기마다 작업을 넣고, 금지 시간에는 넣지 않는다', async () => {
    const userId = await makeUser();
    await addDevice(userId, { pushType: 'APNS', pushToken: `apns-${newId()}` });
    await addDevice(userId, {
      platform: 'WEB',
      pushType: 'WEBPUSH',
      webPushEndpoint: `https://push.example.com/${newId()}`,
      webPushP256dh: 'p256dh',
      webPushAuth: 'auth',
    });
    await addDevice(userId, { pushType: null });
    await addDevice(userId, {
      pushType: 'FCM',
      pushToken: `fcm-${newId()}`,
      revokedAt: new Date(),
    });
    const queued = await push.dispatch([{ userId, ...message() }], NOON);
    expect(queued).toBe(2);
    expect(await push.dispatch([{ userId, ...message() }], kst('23:00'))).toBe(0);
    expect(await push.dispatch([{ userId, ...message('MARKETING') }], kst('21:30'))).toBe(0);
  });

  it('알림을 저장하면 푸시 작업도 넣는다', async () => {
    const userId = await makeUser();
    const spy = vi.spyOn(push, 'dispatch').mockResolvedValue(0);
    const [stored] = await app
      .get(NotificationsService)
      .notify([userId], { type: 'NOTICE', title: '공지', body: '내용', route: '/notices' });
    expect(spy).toHaveBeenCalledWith([
      expect.objectContaining({
        userId,
        notificationId: stored?.id,
        type: 'NOTICE',
        title: '공지',
        route: '/notices',
      }),
    ]);
  });

  it('해지된 토큰이면 그 기기의 푸시 등록을 지우고, 다시 보낼 오류면 던진다', async () => {
    const userId = await makeUser();
    const token = `apns-${newId()}`;
    const deviceId = await addDevice(userId, { pushType: 'APNS', pushToken: token });
    const apns = app.get(ApnsSender);
    vi.spyOn(apns, 'configured', 'get').mockReturnValue(true);

    const send = vi.spyOn(apns, 'send').mockResolvedValueOnce('RETRY');
    await expect(push.deliver({ deviceId, message: message() }, NOON)).rejects.toThrow();

    send.mockResolvedValueOnce('INVALID_TOKEN');
    expect(await push.deliver({ deviceId, message: message() }, NOON)).toBe('INVALID_TOKEN');
    expect(send).toHaveBeenLastCalledWith(token, expect.objectContaining({ title: '제목' }));
    const [device] = await db.select().from(devices).where(eq(devices.id, deviceId));
    expect(device).toMatchObject({ pushType: null, pushToken: null });

    // 등록이 지워진 기기는 더 보내지 않는다
    expect(await push.deliver({ deviceId, message: message() }, NOON)).toBe('SKIPPED');
  });

  it('키가 없는 플랫폼·금지 시간이면 보내지 않고 넘어간다', async () => {
    const userId = await makeUser();
    const deviceId = await addDevice(userId, {
      platform: 'WEB',
      pushType: 'WEBPUSH',
      webPushEndpoint: `https://push.example.com/${newId()}`,
      webPushP256dh: 'p256dh',
      webPushAuth: 'auth',
    });
    const webPush = app.get(WebPushSender);
    const send = vi.spyOn(webPush, 'send');
    vi.spyOn(webPush, 'configured', 'get').mockReturnValue(false);
    expect(await push.deliver({ deviceId, message: message() }, NOON)).toBe('SKIPPED');

    vi.spyOn(webPush, 'configured', 'get').mockReturnValue(true);
    expect(await push.deliver({ deviceId, message: message() }, kst('23:30'))).toBe('SKIPPED');
    expect(send).not.toHaveBeenCalled();
  });
});
