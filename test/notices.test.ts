import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  auditLogs,
  type NewUser,
  notices,
  notifications,
  users,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { createTestApp, inject } from './support/create-test-app.js';

type Item = { noticeId: string; title: string; pinned: boolean; read: boolean };

describe('공지', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let admin: AuthUser;
  const userIds: string[] = [];
  const noticeIds: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `공지${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 1 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (
    user: AuthUser,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const create = async (body: object) => {
    const res = await call(admin, 'POST', '/admin/notices', body);
    expect(res.statusCode).toBe(201);
    const { noticeId } = res.json();
    noticeIds.push(noticeId);
    return noticeId as string;
  };
  const listOf = async (user: AuthUser, query = '') =>
    (await call(user, 'GET', `/notices${query}`)).json() as {
      items: Item[];
      nextCursor: string | null;
    };
  const noticeAlerts = (userId: string) =>
    db
      .select({ body: notifications.body, route: notifications.route })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.type, 'NOTICE')));

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    admin = await makeUser({ role: 'TEACHER', isAdmin: true });
  });

  afterAll(async () => {
    if (noticeIds.length > 0) await db.delete(notices).where(inArray(notices.id, noticeIds));
    await db.delete(notifications).where(inArray(notifications.userId, userIds));
    await db.delete(auditLogs).where(inArray(auditLogs.actorId, userIds));
    await app.close();
  });

  it('고정 공지 먼저 최신순, 초안은 숨기고, 열면 읽음 처리', async () => {
    const student = await makeUser();
    const pinned = await create({ title: '고정', content: '항상 위', pinned: true });
    const older = await create({ title: '예전 공지', content: '내용' });
    const newer = await create({ title: '새 공지', content: '내용', sendPush: true });
    const draft = await create({
      title: '초안',
      content: '내용',
      published: false,
      sendPush: true,
    });

    const first = await listOf(student, '?size=2');
    expect(first.items.map((i) => i.noticeId)).toEqual([pinned, newer]);
    expect(first.items.every((i) => !i.read)).toBe(true);
    const second = await listOf(student, `?size=2&cursor=${first.nextCursor}`);
    expect(second.items.map((i) => i.noticeId)).toEqual([older]);
    expect(second.nextCursor).toBeNull();

    const detail = await call(student, 'GET', `/notices/${newer}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ noticeId: newer, title: '새 공지', content: '내용' });
    expect((await listOf(student)).items.find((i) => i.noticeId === newer)?.read).toBe(true);
    expect((await call(student, 'GET', `/notices/${draft}`)).json().code).toBe('NOTICE_NOT_FOUND');

    // 공개 공지만 알린다
    expect(await noticeAlerts(student.userId)).toEqual([
      { body: '새 공지', route: `/notices/${newer}` },
    ]);
    const adminList = (await call(admin, 'GET', '/admin/notices?size=50')).json();
    expect(adminList.items.find((i: { noticeId: string }) => i.noticeId === draft)).toMatchObject({
      published: false,
      createdBy: expect.any(String),
    });
  });

  it('수정·삭제', async () => {
    const student = await makeUser();
    const noticeId = await create({ title: '고칠 공지', content: '처음' });
    expect(
      (await call(admin, 'PATCH', `/admin/notices/${noticeId}`, { content: '고침', pinned: true }))
        .statusCode,
    ).toBe(204);
    expect((await call(student, 'GET', `/notices/${noticeId}`)).json()).toMatchObject({
      content: '고침',
      pinned: true,
    });
    expect((await call(admin, 'PATCH', `/admin/notices/${noticeId}`, {})).statusCode).toBe(400);

    expect((await call(admin, 'DELETE', `/admin/notices/${noticeId}`)).statusCode).toBe(204);
    expect((await call(student, 'GET', `/notices/${noticeId}`)).statusCode).toBe(404);
    expect((await listOf(student)).items.some((i) => i.noticeId === noticeId)).toBe(false);
    expect((await call(admin, 'DELETE', `/admin/notices/${noticeId}`)).json().code).toBe(
      'NOTICE_NOT_FOUND',
    );
  });

  it('관리자만 쓸 수 있다', async () => {
    const student = await makeUser();
    expect(
      (await call(student, 'POST', '/admin/notices', { title: 't', content: 'c' })).statusCode,
    ).toBe(403);
  });
});
