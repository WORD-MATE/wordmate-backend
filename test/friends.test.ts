import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  friendRequests,
  friendships,
  type NewUser,
  notifications,
  users,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { FRIEND_LIMIT } from '../src/modules/friends/friends.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

describe('친구', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `친구${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 2 : null,
      classNo: role === 'STUDENT' ? 3 : null,
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

  const send = (from: AuthUser, to: AuthUser) =>
    call(from, 'POST', '/friends/requests', { userId: to.userId });

  const friendIdsOf = async (user: AuthUser) =>
    (await call(user, 'GET', '/friends'))
      .json()
      .map((f: { user: { userId: string } }) => f.user.userId);

  const notificationTypes = async (userId: string) =>
    (await db.select().from(notifications).where(eq(notifications.userId, userId))).map(
      (n) => n.type,
    );

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
  });

  afterAll(async () => {
    await db.delete(friendRequests).where(inArray(friendRequests.requesterId, userIds));
    await db.delete(friendships).where(inArray(friendships.userId, userIds));
    await db.delete(notifications).where(inArray(notifications.userId, userIds));
    await app.close();
  });

  it('요청 → 수락하면 양쪽이 친구가 되고 각각 알림을 받는다', async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    const res = await send(a, b);
    expect(res.statusCode).toBe(201);
    const { requestId } = res.json();
    expect(requestId).toEqual(expect.any(String));
    expect(await notificationTypes(b.userId)).toEqual(['FRIEND_REQUEST']);

    const received = (await call(b, 'GET', '/friends/requests')).json();
    expect(received).toEqual([
      expect.objectContaining({ requestId, user: expect.objectContaining({ userId: a.userId }) }),
    ]);
    const sent = (await call(a, 'GET', '/friends/requests?direction=SENT')).json();
    expect(sent.map((r: { user: { userId: string } }) => r.user.userId)).toEqual([b.userId]);

    expect((await send(a, b)).json().code).toBe('FRIEND_REQUEST_DUPLICATE');
    expect((await call(a, 'POST', `/friends/requests/${requestId}/accept`)).statusCode).toBe(403);
    expect((await call(b, 'POST', `/friends/requests/${requestId}/accept`)).statusCode).toBe(204);

    expect(await friendIdsOf(a)).toEqual([b.userId]);
    expect(await friendIdsOf(b)).toEqual([a.userId]);
    expect(await notificationTypes(a.userId)).toEqual(['FRIEND_ACCEPTED']);
    expect((await send(b, a)).json().code).toBe('FRIEND_ALREADY');
    expect((await call(b, 'POST', `/friends/requests/${requestId}/accept`)).json().code).toBe(
      'FRIEND_REQUEST_NOT_FOUND',
    );
  });

  it('상대가 이미 나에게 요청했으면 바로 친구가 된다', async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    await send(a, b);
    const res = await send(b, a);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ requestId: null });
    expect(await friendIdsOf(a)).toEqual([b.userId]);
    expect(
      await db
        .select()
        .from(friendRequests)
        .where(
          and(eq(friendRequests.requesterId, a.userId), eq(friendRequests.receiverId, b.userId)),
        ),
    ).toEqual([]);
    expect(await notificationTypes(a.userId)).toEqual(['FRIEND_ACCEPTED']);
  });

  it('거절·취소, 친구 삭제는 양쪽에서', async () => {
    const [a, b, c] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const toB = (await send(a, b)).json().requestId;
    expect((await call(c, 'DELETE', `/friends/requests/${toB}`)).statusCode).toBe(403);
    expect((await call(b, 'DELETE', `/friends/requests/${toB}`)).statusCode).toBe(204);
    const toC = (await send(a, c)).json().requestId;
    expect((await call(a, 'DELETE', `/friends/requests/${toC}`)).statusCode).toBe(204);
    expect((await call(a, 'DELETE', `/friends/requests/${toC}`)).json().code).toBe(
      'FRIEND_REQUEST_NOT_FOUND',
    );

    await send(a, b);
    await send(b, a);
    expect((await call(b, 'DELETE', `/friends/${a.userId}`)).statusCode).toBe(204);
    expect(await friendIdsOf(a)).toEqual([]);
    expect((await call(b, 'DELETE', `/friends/${a.userId}`)).json().code).toBe('FRIEND_NOT_FOUND');
  });

  it('자기 자신·교사·없는 사용자에게는 못 보내고, 한도를 넘지 못한다', async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    const teacher = await makeUser({ role: 'TEACHER', isAdmin: true });
    expect((await send(a, a)).json().code).toBe('FRIEND_SELF');
    expect((await send(a, teacher)).json().code).toBe('FRIEND_NOT_ALLOWED');
    expect((await call(a, 'POST', '/friends/requests', { userId: newId() })).json().code).toBe(
      'USER_NOT_FOUND',
    );
    expect((await call(teacher, 'GET', '/friends')).statusCode).toBe(403);

    const others = await Promise.all(Array.from({ length: FRIEND_LIMIT }, () => makeUser()));
    const since = new Date();
    await db
      .insert(friendships)
      .values(others.map((o) => ({ userId: a.userId, friendId: o.userId, since })));
    expect((await send(b, a)).json().code).toBe('FRIEND_LIMIT_EXCEEDED');
    expect((await send(a, b)).json().code).toBe('FRIEND_LIMIT_EXCEEDED');
  });

  it('보낸 사람이 정지되면 수락은 404이고 요청은 지워진다', async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    const { requestId } = (await send(a, b)).json();
    await db.update(users).set({ status: 'SUSPENDED' }).where(eq(users.id, a.userId));
    expect((await call(b, 'POST', `/friends/requests/${requestId}/accept`)).json().code).toBe(
      'USER_NOT_FOUND',
    );
    expect((await call(b, 'GET', '/friends/requests')).json()).toEqual([]);
    expect(await friendIdsOf(b)).toEqual([]);
  });

  it('랭킹 친구 범위는 나와 친구', async () => {
    const [a, b, stranger] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    await send(a, b);
    await send(b, a);
    const res = await call(a, 'GET', '/ranking?scope=FRIENDS');
    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((i: { user: { userId: string } }) => i.user.userId);
    expect(ids.sort()).toEqual([a.userId, b.userId].sort());
    expect(ids).not.toContain(stranger.userId);
  });
});
