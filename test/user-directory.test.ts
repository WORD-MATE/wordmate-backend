import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inArray, or } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  blocks,
  friendRequests,
  friendships,
  type NewUser,
  users,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { WITHDRAWN_USER_NAME } from '../src/modules/users/user-summary.js';
import { createTestApp, inject } from './support/create-test-app.js';

type SearchItem = {
  user: { userId: string; name: string };
  isFriend: boolean;
  friendRequest: string | null;
};

describe('사용자 검색·프로필', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];
  // 공유 DB의 다른 사용자와 섞이지 않게 이름·학번에 이 실행만의 표식을 넣는다
  const tag = `검${newId().slice(-6)}`;
  const studentPrefix = `9${Math.floor(Math.random() * 90000 + 10000)}`;

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `${tag}${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 2 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const get = async (user: AuthUser, url: string) =>
    inject(app, {
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const search = async (user: AuthUser, q: string, extra = '') =>
    get(user, `/users/search?q=${encodeURIComponent(q)}${extra}`);

  const befriend = (a: AuthUser, b: AuthUser) =>
    db.insert(friendships).values([
      { userId: a.userId, friendId: b.userId, since: new Date() },
      { userId: b.userId, friendId: a.userId, since: new Date() },
    ]);
  const request = (from: AuthUser, to: AuthUser) =>
    db
      .insert(friendRequests)
      .values({ id: newId(), requesterId: from.userId, receiverId: to.userId });
  const block = (from: AuthUser, to: AuthUser) =>
    db.insert(blocks).values({ blockerId: from.userId, blockedId: to.userId });

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
  });

  afterAll(async () => {
    await db
      .delete(blocks)
      .where(or(inArray(blocks.blockerId, userIds), inArray(blocks.blockedId, userIds)));
    await db.delete(friendRequests).where(inArray(friendRequests.requesterId, userIds));
    await db.delete(friendships).where(inArray(friendships.userId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
    await app.close();
  });

  describe('검색', () => {
    it('교사·나·나를 차단한 사용자·쓸 수 없는 계정은 빼고, 내가 차단한 사용자는 넣는다', async () => {
      const me = await makeUser({ name: `${tag}목0` });
      const friend = await makeUser({ name: `${tag}목1` });
      const sent = await makeUser({ name: `${tag}목2` });
      const received = await makeUser({ name: `${tag}목3` });
      const blockedByMe = await makeUser({ name: `${tag}목4` });
      const blocker = await makeUser({ name: `${tag}목5` });
      await makeUser({ name: `${tag}목6`, role: 'TEACHER', isAdmin: true });
      await makeUser({ name: `${tag}목7`, status: 'SUSPENDED' });
      await makeUser({ name: `${tag}목8`, status: 'INACTIVE' });
      await makeUser({ name: `${tag}목9`, status: 'WITHDRAWN' });
      const hidden = await makeUser({ name: `${tag}목A`, rankingPublic: false });
      await befriend(me, friend);
      await request(me, sent);
      await request(received, me);
      await block(me, blockedByMe);
      await block(blocker, me);

      const res = await search(me, `${tag}목`);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.nextCursor).toBeNull();
      expect(body.items).toEqual([
        {
          user: expect.objectContaining({ userId: friend.userId }),
          isFriend: true,
          friendRequest: null,
        },
        {
          user: expect.objectContaining({ userId: sent.userId }),
          isFriend: false,
          friendRequest: 'SENT',
        },
        {
          user: expect.objectContaining({ userId: received.userId }),
          isFriend: false,
          friendRequest: 'RECEIVED',
        },
        {
          user: expect.objectContaining({ userId: blockedByMe.userId }),
          isFriend: false,
          friendRequest: null,
        },
        {
          user: expect.objectContaining({ userId: hidden.userId, tier: null }),
          isFriend: false,
          friendRequest: null,
        },
      ]);
      expect(body.items[0].user).toEqual({
        userId: friend.userId,
        name: `${tag}목1`,
        grade: 1,
        classNo: 2,
        avatarId: 'default',
        tier: 'BRONZE',
      });
    });

    it('이름 가운데 글자와 학번 앞부분으로 찾고, 학번은 응답에 넣지 않는다', async () => {
      const me = await makeUser();
      const target = await makeUser({ name: `${tag}학번용`, studentNumber: `${studentPrefix}1` });

      const byName = (await search(me, '번용')).json().items as SearchItem[];
      expect(byName.map((item) => item.user.userId)).toContain(target.userId);

      const res = await search(me, studentPrefix);
      expect(res.json().items.map((item: SearchItem) => item.user.userId)).toEqual([target.userId]);
      expect(res.body).not.toContain(`${studentPrefix}1`);
      expect(res.body).not.toContain('studentNumber');
    });

    it('cursor로 이름순으로 끝까지 겹치지 않게 넘긴다', async () => {
      const me = await makeUser();
      const prefix = `${tag}쪽`;
      const created: string[] = [];
      for (const suffix of ['다', '가', '나', '가', '라']) {
        created.push((await makeUser({ name: `${prefix}${suffix}` })).userId);
      }

      const seen: SearchItem[] = [];
      let cursor: string | null = null;
      do {
        const extra: string = `&size=2${cursor ? `&cursor=${cursor}` : ''}`;
        const body: { items: SearchItem[]; nextCursor: string | null } = (
          await search(me, prefix, extra)
        ).json();
        expect(body.items.length).toBeLessThanOrEqual(2);
        seen.push(...body.items);
        cursor = body.nextCursor;
      } while (cursor);

      expect(seen.map((item) => item.user.name)).toEqual(
        ['가', '가', '나', '다', '라'].map((s) => `${prefix}${s}`),
      );
      expect(new Set(seen.map((item) => item.user.userId))).toEqual(new Set(created));
    });

    it('LIKE 특수문자는 글자 그대로 찾는다', async () => {
      const me = await makeUser();
      expect((await search(me, `${tag}%`)).json().items).toEqual([]);
      expect((await search(me, `${tag}_`)).json().items).toEqual([]);
    });

    it('검색어가 없으면 400, 교사는 403, 잘못된 cursor는 400', async () => {
      const me = await makeUser();
      const teacher = await makeUser({ role: 'TEACHER', isAdmin: true });
      expect((await get(me, '/users/search')).statusCode).toBe(400);
      expect((await search(me, '   ')).statusCode).toBe(400);
      expect((await search(teacher, tag)).statusCode).toBe(403);
      expect((await search(me, tag, '&cursor=broken')).json().code).toBe('INVALID_REQUEST');
    });
  });

  describe('프로필', () => {
    it('공개한 학생은 레벨·티어와 관계를 보여준다', async () => {
      const me = await makeUser();
      const target = await makeUser({ totalXp: 50 });
      await befriend(me, target);

      const res = await get(me, `/users/${target.userId}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        user: {
          userId: target.userId,
          name: expect.any(String),
          grade: 1,
          classNo: 2,
          avatarId: 'default',
          tier: 'BRONZE',
        },
        isMe: false,
        isPublic: true,
        level: 1,
        tier: 'BRONZE',
        representativeBadge: null,
        relation: { isFriend: true, friendRequest: null, isBlocked: false },
      });
    });

    it('랭킹 비공개면 레벨·티어가 null이고, 내 프로필은 보인다', async () => {
      const me = await makeUser({ rankingPublic: false });
      const other = await makeUser();

      expect((await get(other, `/users/${me.userId}`)).json()).toMatchObject({
        isMe: false,
        isPublic: false,
        level: null,
        tier: null,
        user: { tier: null },
      });
      expect((await get(me, `/users/${me.userId}`)).json()).toMatchObject({
        isMe: true,
        isPublic: false,
        level: 1,
        tier: 'BRONZE',
        relation: { isFriend: false, friendRequest: null, isBlocked: false },
      });
    });

    it('친구 요청 방향과 내가 차단했는지를 알려준다', async () => {
      const me = await makeUser();
      const [sent, received, blocked] = await Promise.all([makeUser(), makeUser(), makeUser()]);
      await request(me, sent);
      await request(received, me);
      await block(me, blocked);

      expect((await get(me, `/users/${sent.userId}`)).json().relation).toEqual({
        isFriend: false,
        friendRequest: 'SENT',
        isBlocked: false,
      });
      expect((await get(me, `/users/${received.userId}`)).json().relation.friendRequest).toBe(
        'RECEIVED',
      );
      expect((await get(me, `/users/${blocked.userId}`)).json().relation.isBlocked).toBe(true);
    });

    it('탈퇴한 사용자는 이름만 "탈퇴한 사용자"로 보여준다', async () => {
      const me = await makeUser();
      const withdrawn = await makeUser({ status: 'WITHDRAWN', totalXp: 300 });

      const res = await get(me, `/users/${withdrawn.userId}`);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        user: { name: WITHDRAWN_USER_NAME, grade: null, classNo: null, tier: null },
        isPublic: false,
        level: null,
        tier: null,
        representativeBadge: null,
      });
    });

    it('나를 차단한 사용자·없는 사용자는 404, uuid가 아니면 400', async () => {
      const me = await makeUser();
      const blocker = await makeUser();
      await block(blocker, me);

      expect((await get(me, `/users/${blocker.userId}`)).json().code).toBe('USER_NOT_FOUND');
      expect((await get(me, `/users/${newId()}`)).json().code).toBe('USER_NOT_FOUND');
      expect((await get(me, '/users/not-a-uuid')).statusCode).toBe(400);
      expect((await get(blocker, `/users/${me.userId}`)).statusCode).toBe(200);
    });

    it('교사도 볼 수 있고, 교사 프로필은 레벨·티어가 없다', async () => {
      const teacher = await makeUser({ role: 'TEACHER', isAdmin: true });
      const student = await makeUser();

      expect((await get(teacher, `/users/${student.userId}`)).json()).toMatchObject({
        level: 1,
        relation: { isFriend: false, friendRequest: null, isBlocked: false },
      });
      expect((await get(student, `/users/${teacher.userId}`)).json()).toMatchObject({
        isPublic: false,
        level: null,
        tier: null,
        user: { grade: null, classNo: null, tier: null },
      });
    });

    it('/users/me·/users/search 같은 고정 경로를 가리지 않는다', async () => {
      const me = await makeUser();
      const res = await get(me, '/users/me');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ userId: me.userId, studentNumber: null });
      expect((await get(me, '/users/search')).json().code).toBe('INVALID_REQUEST');
    });
  });
});
