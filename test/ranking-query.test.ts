import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { type NewUser, users } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { RankingService } from '../src/modules/ranking/ranking.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

type Entry = { rank: number; user: { userId: string }; xp: number };

describe('랭킹 조회', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let valkey: Redis;
  let ranking: RankingService;
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `랭커${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 3 : null,
      classNo: role === 'STUDENT' ? 11 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: false, deviceId: newId() };
  };

  const call = async (user: AuthUser, url: string) =>
    inject(app, {
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });
  const ids = (entries: Entry[]) => entries.map((e) => e.user.userId);

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    valkey = app.get(VALKEY);
    ranking = app.get(RankingService);
  });

  // 목록은 5분 캐시라 테스트마다 비운다
  beforeEach(async () => {
    const keys = await valkey.keys('rank:top:*');
    if (keys.length > 0) await valkey.del(...keys);
  });

  afterAll(async () => {
    await app.close();
  });

  it('반 랭킹: XP 순, 같으면 먼저 도달한 순, 비공개·정지 사용자는 빠지고 페이지를 넘긴다', async () => {
    const a = await makeUser();
    const b = await makeUser();
    const c = await makeUser();
    const d = await makeUser();
    const hidden = await makeUser({ rankingPublic: false });
    const suspended = await makeUser({ status: 'SUSPENDED' });
    // 다른 테스트 사용자보다 위에 오도록 크게 준다
    await ranking.addXp(a.userId, 3000, minutesAgo(50));
    await ranking.addXp(b.userId, 2000, minutesAgo(40));
    await ranking.addXp(c.userId, 2000, minutesAgo(30));
    await ranking.addXp(d.userId, 1000, minutesAgo(20));
    await ranking.addXp(hidden.userId, 5000, minutesAgo(10));
    await ranking.addXp(suspended.userId, 4000, minutesAgo(10));

    const first = (await call(a, '/ranking?scope=CLASS&size=2')).json();
    expect(first).toMatchObject({ available: true });
    expect(first.updatedAt).toEqual(expect.any(String));
    expect(first.items).toMatchObject([
      { rank: 1, xp: 3000, user: { userId: a.userId, grade: 3, classNo: 11 } },
      { rank: 2, xp: 2000, user: { userId: b.userId } },
    ]);
    const second = (await call(a, `/ranking?scope=CLASS&size=2&cursor=${first.nextCursor}`)).json();
    expect(second.items.map((e: Entry) => [e.rank, e.user.userId])).toEqual([
      [3, c.userId],
      [4, d.userId],
    ]);
    expect(second.nextCursor).toBeNull();

    // 학교 범위에도 같은 순서로 들어 있다 (다른 테스트 사용자와 섞여 있어 상대 순서만 본다)
    const school = ids((await call(a, '/ranking?size=50')).json().items);
    const mine = school.filter((id) => [a, b, c, d, hidden].some((u) => u.userId === id));
    expect(mine).toEqual([a.userId, b.userId, c.userId, d.userId]);

    // 목록은 5분 캐시라 바로 바뀌지 않는다
    await ranking.addXp(d.userId, 5000);
    expect(ids((await call(a, '/ranking?scope=CLASS')).json().items)[0]).toBe(a.userId);
  });

  it('내 순위: 비공개여도 보이고, 동점 차이·XP 0·지난 주 대비 변동', async () => {
    const cls = { grade: 3, classNo: 12 };
    const top = await makeUser(cls);
    const tied = await makeUser(cls);
    const hidden = await makeUser({ ...cls, rankingPublic: false });
    const zero = await makeUser(cls);
    const lastWeek = new Date(Date.now() - 7 * 24 * 60 * 60_000);
    await ranking.addXp(tied.userId, 100, lastWeek);
    await ranking.addXp(top.userId, 50, lastWeek);
    await ranking.addXp(top.userId, 40, minutesAgo(30));
    await ranking.addXp(tied.userId, 40, minutesAgo(20));
    await ranking.addXp(hidden.userId, 45, minutesAgo(10));

    expect((await call(top, '/ranking/me?scope=CLASS')).json()).toEqual({
      rank: 1,
      topPercent: null,
      xp: 40,
      gapToNext: null,
      change: 1,
      rankingPublic: true,
    });
    expect((await call(tied, '/ranking/me?scope=CLASS')).json()).toMatchObject({
      rank: 2,
      xp: 40,
      gapToNext: 0,
      change: -1,
    });
    // 비공개 사용자는 목록에 없지만 본인 순위는 공개 사용자 사이에 끼워 계산
    expect((await call(hidden, '/ranking/me?scope=CLASS')).json()).toMatchObject({
      rank: 1,
      xp: 45,
      rankingPublic: false,
      change: null,
    });
    expect((await call(zero, '/ranking/me?scope=CLASS')).json()).toEqual({
      rank: null,
      topPercent: null,
      xp: 0,
      gapToNext: null,
      change: null,
      rankingPublic: true,
    });
    // 이 반은 공개 참여자가 2명이라 반 랭킹은 숨김
    expect((await call(top, '/ranking?scope=CLASS')).json()).toEqual({
      available: false,
      updatedAt: expect.any(String),
      items: [],
      nextCursor: null,
    });
  });

  it('100위 밖이면 rank 대신 상위 %', async () => {
    const cls = { grade: 3, classNo: 13 };
    const crowd = Array.from({ length: 101 }, () => ({
      id: newId(),
      name: '참가자',
      role: 'STUDENT' as const,
      ...cls,
    }));
    await db.insert(users).values(crowd);
    await Promise.all(crowd.map((u, i) => ranking.addXp(u.id, 1000 + i)));
    const me = await makeUser(cls);
    await ranking.addXp(me.userId, 1);

    expect((await call(me, '/ranking/me?scope=CLASS')).json()).toMatchObject({
      rank: null,
      topPercent: 100,
      xp: 1,
    });
    expect((await call(me, '/ranking?scope=CLASS&size=50')).json().items).toHaveLength(50);
  });

  it('교사는 학교 범위만, 내 순위는 403. 친구 범위는 친구 기능 전까지 나만', async () => {
    const teacher = await makeUser({ role: 'TEACHER' });
    expect((await call(teacher, '/ranking')).statusCode).toBe(200);
    expect((await call(teacher, '/ranking?scope=GRADE')).statusCode).toBe(403);
    expect((await call(teacher, '/ranking/me')).statusCode).toBe(403);

    const student = await makeUser({ grade: 3, classNo: 14 });
    await ranking.addXp(student.userId, 7);
    expect((await call(student, '/ranking?scope=FRIENDS')).json().items).toMatchObject([
      { rank: 1, xp: 7, user: { userId: student.userId } },
    ]);
    expect((await call(student, '/ranking/me?scope=FRIENDS')).json()).toMatchObject({
      rank: 1,
      xp: 7,
    });
    expect((await call(student, '/ranking?period=DAILY')).statusCode).toBe(400);
  });
});
