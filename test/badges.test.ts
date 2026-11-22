import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  type NewUser,
  notifications,
  userBadges,
  userStreaks,
  users,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { BadgesService } from '../src/modules/badges/badges.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

type Badge = { name: string; earned: boolean; earnedAt: string | null };

describe('배지', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `배지${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 3 : null,
      classNo: role === 'STUDENT' ? 1 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const badgesOf = async (viewer: AuthUser, userId?: string) =>
    inject(app, {
      method: 'GET',
      url: userId ? `/badges?userId=${userId}` : '/badges',
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(viewer)}` },
    });

  const badgeNotifications = async (userId: string) =>
    db
      .select({ body: notifications.body })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.type, 'BADGE_EARNED')));

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
  });

  afterAll(async () => {
    await db.delete(notifications).where(inArray(notifications.userId, userIds));
    await app.close();
  });

  it('조건을 채우면 한 번만 주고 알린다', async () => {
    const user = await makeUser({ totalXp: 1200 });
    const before = (await badgesOf(user)).json();
    expect(before).toHaveLength(9);
    expect(before.every((b: Badge) => !b.earned && b.earnedAt === null)).toBe(true);

    await db.insert(userStreaks).values({
      userId: user.userId,
      kind: 'STUDY',
      current: 0,
      best: 7,
      lastDate: '2026-01-01',
    });
    const service = app.get(BadgesService);
    await service.evaluate(user.userId);
    await service.evaluate(user.userId);

    const earned = (await badgesOf(user))
      .json()
      .filter((b: Badge) => b.earned)
      .map((b: Badge) => b.name);
    expect(earned).toEqual(['일주일 연속', 'XP 1,000']);
    expect((await badgeNotifications(user.userId)).map((n) => n.body).sort()).toEqual(
      ["'XP 1,000' 배지를 얻었어요.", "'일주일 연속' 배지를 얻었어요."].sort(),
    );
  });

  it('다른 사람은 획득한 것만, 랭킹 비공개면 빈 배열, 없거나 탈퇴하면 404', async () => {
    const [viewer, other] = await Promise.all([makeUser(), makeUser({ totalXp: 1000 })]);
    await app.get(BadgesService).evaluate(other.userId);
    const res = await badgesOf(viewer, other.userId);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([
      expect.objectContaining({ name: 'XP 1,000', earned: true, type: 'ACHIEVEMENT' }),
    ]);

    await db.update(users).set({ rankingPublic: false }).where(eq(users.id, other.userId));
    expect((await badgesOf(viewer, other.userId)).json()).toEqual([]);
    expect((await badgesOf(other)).json().filter((b: Badge) => b.earned)).toHaveLength(1);

    expect((await badgesOf(viewer, newId())).json().code).toBe('USER_NOT_FOUND');
    await db.update(users).set({ status: 'WITHDRAWN' }).where(eq(users.id, other.userId));
    expect((await badgesOf(viewer, other.userId)).statusCode).toBe(404);
    expect(
      await db.select().from(userBadges).where(eq(userBadges.userId, other.userId)),
    ).toHaveLength(1);
  });
});
