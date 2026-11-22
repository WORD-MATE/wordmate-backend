import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  type NewUser,
  notificationSettings,
  notifications,
  userAgreements,
  users,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { MaintenanceService } from '../src/modules/maintenance/maintenance.service.js';
import { NotificationsService } from '../src/modules/notifications/notifications.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('알림', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let service: NotificationsService;
  const userIds: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `알림${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 1 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (
    user: AuthUser,
    method: 'GET' | 'PATCH' | 'PUT',
    url: string,
    payload?: object,
  ) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const allOn = {
    STUDY_REMINDER: true,
    MORNING_SENTENCE: true,
    BATTLE: true,
    RANKING: true,
    NOTICE: true,
    MARKETING: false,
  };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    service = app.get(NotificationsService);
  });

  afterAll(async () => {
    await db.delete(notifications).where(inArray(notifications.userId, userIds));
    await db.delete(notificationSettings).where(inArray(notificationSettings.userId, userIds));
    await db.delete(userAgreements).where(inArray(userAgreements.userId, userIds));
    await app.close();
  });

  it('목록은 최신순 커서, 읽음·전체 읽음·안 읽은 수, 남의 알림은 404', async () => {
    const me = await makeUser();
    const other = await makeUser();
    for (let i = 0; i < 3; i++) {
      await service.notify([me.userId], {
        type: 'NOTICE',
        title: `공지 ${i}`,
        body: `본문 ${i}`,
        route: '/notices',
      });
    }
    const [othersOne] = await service.notify([other.userId], {
      type: 'NOTICE',
      title: '남의 공지',
      body: '본문',
    });

    const page1 = (await call(me, 'GET', '/notifications?size=2')).json();
    expect(page1.items.map((n: { title: string }) => n.title)).toEqual(['공지 2', '공지 1']);
    expect(page1.items[0]).toMatchObject({ type: 'NOTICE', route: '/notices', read: false });
    const page2 = (
      await call(me, 'GET', `/notifications?size=2&cursor=${page1.nextCursor}`)
    ).json();
    expect(page2.items.map((n: { title: string }) => n.title)).toEqual(['공지 0']);
    expect(page2.nextCursor).toBeNull();
    expect((await call(me, 'GET', '/notifications/unread-count')).json()).toEqual({ count: 3 });

    const first = page1.items[0].notificationId;
    expect((await call(me, 'PATCH', `/notifications/${first}/read`)).statusCode).toBe(204);
    expect((await call(me, 'PATCH', `/notifications/${first}/read`)).statusCode).toBe(204);
    expect((await call(me, 'GET', '/notifications/unread-count')).json()).toEqual({ count: 2 });
    expect((await call(me, 'PATCH', `/notifications/${othersOne?.id}/read`)).json().code).toBe(
      'NOTI_NOT_FOUND',
    );

    expect((await call(me, 'PATCH', '/notifications/read-all')).statusCode).toBe(204);
    expect((await call(me, 'GET', '/notifications/unread-count')).json()).toEqual({ count: 0 });
    expect((await call(other, 'GET', '/notifications/unread-count')).json()).toEqual({ count: 1 });
  });

  it('30일 지난 알림은 목록·안 읽은 수에서 빠지고 정리 작업이 지운다', async () => {
    const me = await makeUser();
    const [old] = await service.notify([me.userId], { type: 'NOTICE', title: '옛 공지', body: '' });
    await db
      .update(notifications)
      .set({ createdAt: new Date(Date.now() - 31 * DAY_MS) })
      .where(eq(notifications.id, old?.id as string));
    expect((await call(me, 'GET', '/notifications')).json().items).toEqual([]);
    expect((await call(me, 'GET', '/notifications/unread-count')).json()).toEqual({ count: 0 });
    expect(await app.get(MaintenanceService).purgeNotifications()).toBeGreaterThanOrEqual(1);
    expect(
      await db
        .select()
        .from(notifications)
        .where(eq(notifications.id, old?.id as string)),
    ).toEqual([]);
  });

  it('설정: 처음엔 기본값, 끈 분류는 저장하지 않고 끌 수 없는 알림은 항상 저장', async () => {
    const me = await makeUser();
    expect((await call(me, 'GET', '/notifications/settings')).json()).toEqual({
      categories: allOn,
      reminder: { time: null, weekdays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] },
      marketingAgreed: false,
    });

    const res = await call(me, 'PUT', '/notifications/settings', {
      categories: { ...allOn, BATTLE: false },
      reminder: { time: '21:30', weekdays: ['MON', 'WED'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      categories: { BATTLE: false, RANKING: true },
      reminder: { time: '21:30', weekdays: ['MON', 'WED'] },
    });

    expect(
      await service.notify([me.userId], { type: 'BATTLE_INVITE', title: '초대', body: '' }),
    ).toEqual([]);
    expect(
      await service.notify([me.userId], { type: 'FRIEND_REQUEST', title: '친구 요청', body: '' }),
    ).toHaveLength(1);
  });

  it('리마인더 시간은 07:00~22:00, 광고성은 마케팅 동의가 있어야 켜고 받는다', async () => {
    const me = await makeUser();
    const reminder = { time: null, weekdays: [] };
    expect(
      (
        await call(me, 'PUT', '/notifications/settings', {
          categories: allOn,
          reminder: { time: '22:30', weekdays: ['MON'] },
        })
      ).json().code,
    ).toBe('NOTI_REMINDER_TIME_OUT_OF_RANGE');
    expect(
      (
        await call(me, 'PUT', '/notifications/settings', {
          categories: allOn,
          reminder: { time: '7:00', weekdays: ['MON'] },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(me, 'PUT', '/notifications/settings', {
          categories: { ...allOn, MARKETING: true },
          reminder,
        })
      ).json().code,
    ).toBe('NOTI_MARKETING_AGREEMENT_REQUIRED');

    await db.insert(userAgreements).values({
      id: newId(),
      userId: me.userId,
      policyType: 'MARKETING',
      version: '1.0',
      agreed: true,
      agreedAt: new Date(),
    });
    const on = await call(me, 'PUT', '/notifications/settings', {
      categories: { ...allOn, MARKETING: true },
      reminder,
    });
    expect(on.json()).toMatchObject({ categories: { MARKETING: true }, marketingAgreed: true });
    expect(
      await service.notify([me.userId], { type: 'MARKETING', title: '이벤트', body: '' }),
    ).toHaveLength(1);

    // 동의를 철회하면 켜 둔 설정과 상관없이 받지 않는다
    await db.insert(userAgreements).values({
      id: newId(),
      userId: me.userId,
      policyType: 'MARKETING',
      version: '1.0',
      agreed: false,
      agreedAt: new Date(),
    });
    expect(
      await service.notify([me.userId], { type: 'MARKETING', title: '이벤트', body: '' }),
    ).toEqual([]);
  });
});
