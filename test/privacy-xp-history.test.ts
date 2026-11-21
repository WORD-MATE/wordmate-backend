import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { users, xpLedger } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { createTestApp, inject } from './support/create-test-app.js';

describe('랭킹 공개 설정·XP 적립 내역', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];

  const makeUser = async (role: 'STUDENT' | 'TEACHER' = 'STUDENT'): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    await db.insert(users).values({
      id: userId,
      name: '설정유저',
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 1 : null,
    });
    return { userId, role, isAdmin: false, deviceId: newId() };
  };

  const call = async (user: AuthUser, method: 'GET' | 'PATCH', url: string, payload?: object) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
  });

  afterAll(async () => {
    await db.delete(xpLedger).where(inArray(xpLedger.userId, userIds));
    await app.close();
  });

  it('랭킹 공개 설정을 바꾸면 안내 확인도 함께 처리된다, 교사는 403', async () => {
    const student = await makeUser();
    const res = await call(student, 'PATCH', '/users/me/privacy', { rankingPublic: false });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ rankingPublic: false, rankingOnboarded: true });
    expect((await call(student, 'GET', '/users/me')).json()).toMatchObject({
      rankingPublic: false,
    });

    expect(
      (await call(student, 'PATCH', '/users/me/privacy', { rankingPublic: true })).json(),
    ).toEqual({ rankingPublic: true, rankingOnboarded: true });
    expect((await call(student, 'PATCH', '/users/me/privacy', {})).statusCode).toBe(400);

    const teacher = await makeUser('TEACHER');
    expect(
      (await call(teacher, 'PATCH', '/users/me/privacy', { rankingPublic: false })).statusCode,
    ).toBe(403);
  });

  it('XP 적립 내역은 최신순, 상한에 걸린 지급·관리자 조정도 보이고 남의 것은 안 보인다', async () => {
    const student = await makeUser();
    const other = await makeUser();
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    await db.insert(xpLedger).values([
      {
        id: newId(),
        userId: student.userId,
        source: 'STUDY',
        refKey: 'h:1',
        amount: 12,
        date: '2026-11-20',
        createdAt: at(30),
      },
      {
        id: newId(),
        userId: student.userId,
        source: 'PACK_COMPLETE',
        refKey: 'h:2',
        amount: 0,
        blockedReason: 'DAILY_CAP',
        date: '2026-11-20',
        createdAt: at(20),
      },
      {
        id: newId(),
        userId: student.userId,
        source: 'ADMIN_ADJUST',
        refKey: 'h:3',
        amount: -5,
        date: '2026-11-20',
        createdAt: at(10),
      },
      {
        id: newId(),
        userId: other.userId,
        source: 'STUDY',
        refKey: 'h:4',
        amount: 99,
        date: '2026-11-20',
        createdAt: at(5),
      },
    ]);

    const first = (await call(student, 'GET', '/users/me/xp-history?size=2')).json();
    expect(first.items.map((i: { title: string; amount: number }) => [i.title, i.amount])).toEqual([
      ['관리자 조정', -5],
      ['단어팩 완주', 0],
    ]);
    expect(first.items[1]).toMatchObject({ source: 'PACK_COMPLETE', blockedReason: 'DAILY_CAP' });
    const second = (
      await call(student, 'GET', `/users/me/xp-history?size=2&cursor=${first.nextCursor}`)
    ).json();
    expect(second.items).toMatchObject([
      { source: 'STUDY', title: '단어 학습', amount: 12, blockedReason: null },
    ]);
    expect(second.nextCursor).toBeNull();

    const teacher = await makeUser('TEACHER');
    expect((await call(teacher, 'GET', '/users/me/xp-history')).statusCode).toBe(403);
  });
});
