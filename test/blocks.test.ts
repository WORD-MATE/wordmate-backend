import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  blocks,
  friendRequests,
  friendships,
  type NewUser,
  notifications,
  users,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { createTestApp, inject } from './support/create-test-app.js';

describe('차단', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `차단${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 2 : null,
      classNo: role === 'STUDENT' ? 4 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (
    user: AuthUser,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const block = (from: AuthUser, to: AuthUser) =>
    call(from, 'POST', '/blocks', { userId: to.userId });
  const befriend = async (a: AuthUser, b: AuthUser) => {
    await call(a, 'POST', '/friends/requests', { userId: b.userId });
    await call(b, 'POST', '/friends/requests', { userId: a.userId });
  };
  const friendIdsOf = async (user: AuthUser) =>
    (await call(user, 'GET', '/friends'))
      .json()
      .map((f: { user: { userId: string } }) => f.user.userId);

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
  });

  afterAll(async () => {
    await db.delete(blocks).where(inArray(blocks.blockerId, userIds));
    await db.delete(friendRequests).where(inArray(friendRequests.requesterId, userIds));
    await db.delete(friendships).where(inArray(friendships.userId, userIds));
    await db.delete(notifications).where(inArray(notifications.userId, userIds));
    await app.close();
  });

  it('차단하면 친구 관계와 대기 중인 요청이 지워지고, 풀어도 되살리지 않는다', async () => {
    const [a, b, c] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    await befriend(a, b);
    await call(c, 'POST', '/friends/requests', { userId: a.userId });
    expect(await friendIdsOf(a)).toEqual([b.userId]);

    expect((await block(a, b)).statusCode).toBe(204);
    expect((await block(a, c)).statusCode).toBe(204);
    expect(await friendIdsOf(a)).toEqual([]);
    expect(await friendIdsOf(b)).toEqual([]);
    expect(
      await db
        .select()
        .from(friendRequests)
        .where(
          or(eq(friendRequests.requesterId, c.userId), eq(friendRequests.receiverId, c.userId)),
        ),
    ).toEqual([]);
    expect(await db.select().from(notifications).where(eq(notifications.userId, b.userId))).toEqual(
      [],
    );

    const list = (await call(a, 'GET', '/blocks')).json();
    expect(list.map((r: { user: { userId: string } }) => r.user.userId).sort()).toEqual(
      [b.userId, c.userId].sort(),
    );
    expect((await call(b, 'GET', '/blocks')).json()).toEqual([]);

    expect((await call(a, 'DELETE', `/blocks/${b.userId}`)).statusCode).toBe(204);
    expect(await friendIdsOf(a)).toEqual([]);
    expect((await call(a, 'DELETE', `/blocks/${b.userId}`)).json().code).toBe('BLOCK_NOT_FOUND');
  });

  it('어느 쪽이든 차단했으면 친구 요청을 보낼 수 없다', async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    await block(a, b);
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const res = await call(from, 'POST', '/friends/requests', { userId: to.userId });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('FRIEND_NOT_ALLOWED');
    }
    expect((await block(b, a)).statusCode).toBe(204);
  });

  it('자기 자신·교사·없는 사용자는 차단할 수 없고, 두 번 차단하면 409', async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    const teacher = await makeUser({ role: 'TEACHER', isAdmin: true });
    expect((await block(a, a)).json().code).toBe('BLOCK_SELF');
    expect((await block(a, teacher)).json().code).toBe('BLOCK_NOT_ALLOWED');
    expect((await call(a, 'POST', '/blocks', { userId: newId() })).json().code).toBe(
      'USER_NOT_FOUND',
    );
    await block(a, b);
    expect((await block(a, b)).json().code).toBe('BLOCK_ALREADY');
    expect((await call(teacher, 'GET', '/blocks')).statusCode).toBe(403);
  });
});
