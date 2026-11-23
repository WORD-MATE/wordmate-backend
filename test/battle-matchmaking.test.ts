import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  battleRoomParticipants,
  battleRooms,
  blocks,
  type NewUser,
  packs,
  users,
  words,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { MatchmakingService } from '../src/modules/battles/matchmaking.service.js';
import { RoomsService } from '../src/modules/battles/rooms.service.js';
import { RealtimeService } from '../src/modules/realtime/realtime.service.js';
import { createTestApp, inject } from './support/create-test-app.js';
import { connectAs, type WsClient, wsBaseOf } from './support/ws-client.js';

describe('빠른 1:1 매칭', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let valkey: Redis;
  let defaultPackId: string;
  const userIds: string[] = [];
  const clients: WsClient[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `매칭${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 1 : null,
      ...overrides,
    });
    return {
      userId,
      role,
      isAdmin: overrides.isAdmin ?? false,
      deviceId: newId(),
    };
  };

  const call = async (user: AuthUser, method: 'POST' | 'DELETE', url: string, payload?: object) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const online = async (overrides: Partial<NewUser> = {}) => {
    const client = await connectAs(app, await makeUser(overrides));
    clients.push(client);
    return client;
  };

  const enqueue = (client: WsClient) => call(client.user, 'POST', '/battles/matchmaking');

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    valkey = app.get(VALKEY);
    await app.listen(0, '127.0.0.1');
    const admin = await makeUser({ role: 'TEACHER', isAdmin: true });
    const created = await inject(app, {
      method: 'POST',
      url: '/packs',
      payload: { name: `매칭기본 ${newId().slice(-6)}`, type: 'DEFAULT' },
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(admin)}` },
    });
    defaultPackId = created.json().packId;
    await inject(app, {
      method: 'POST',
      url: `/packs/${defaultPackId}/words`,
      payload: {
        words: Array.from({ length: 10 }, (_, i) => ({
          english: `match${i}`,
          meanings: [`매칭${i}`],
        })),
      },
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(admin)}` },
    });
    // 다른 테스트가 남긴 기본 팩보다 앞에 오게
    await db.update(packs).set({ sortOrder: -100_000 }).where(eq(packs.id, defaultPackId));
  });

  beforeEach(async () => {
    await valkey.del('mm:queue', 'mm:queued');
  });

  afterAll(async () => {
    for (const client of clients) client.socket.terminate();
    await db.delete(blocks).where(inArray(blocks.blockerId, userIds));
    await valkey.del('mm:queue', 'mm:queued');
    const rooms = await db
      .select({ id: battleRooms.id })
      .from(battleRooms)
      .where(inArray(battleRooms.hostUserId, userIds));
    if (rooms.length > 0) {
      await db.delete(battleRooms).where(
        inArray(
          battleRooms.id,
          rooms.map((r) => r.id),
        ),
      );
    }
    await db.delete(battleRoomParticipants).where(inArray(battleRoomParticipants.userId, userIds));
    const owned = await db
      .select({ id: packs.id })
      .from(packs)
      .where(inArray(packs.ownerUserId, userIds));
    const ids = [...owned.map((row) => row.id), defaultPackId];
    await db.delete(words).where(inArray(words.packId, ids));
    await db.delete(packs).where(inArray(packs.id, ids));
    await app.close();
  });

  it('WebSocket에 접속해야 하고, 교사는 못 한다', async () => {
    const offline = await makeUser();
    expect((await call(offline, 'POST', '/battles/matchmaking')).json().code).toBe(
      'MATCH_WS_NOT_CONNECTED',
    );
    const teacher = await makeUser({ role: 'TEACHER', isAdmin: true });
    expect((await call(teacher, 'POST', '/battles/matchmaking')).statusCode).toBe(403);
  });

  it('연결이 열리자마자 요청해도 접속 확인을 잠깐 기다려 대기열에 넣는다', async () => {
    const user = await makeUser();
    const headers = { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` };
    const { ticket } = (
      await inject(app, { method: 'POST', url: '/realtime/ticket', headers })
    ).json();
    // 서버가 티켓을 늦게 확인하는 상황을 만든다 (그동안 매칭 요청이 먼저 도착)
    const realtime = app.get(RealtimeService);
    const redeem = realtime.redeemTicket.bind(realtime);
    const spy = vi.spyOn(realtime, 'redeemTicket').mockImplementation(async (value) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return redeem(value);
    });
    const socket = new WebSocket(`${wsBaseOf(app)}?ticket=${ticket}`);
    socket.on('error', () => {});
    try {
      const res = await inject(app, { method: 'POST', url: '/battles/matchmaking', headers });
      expect(res.statusCode).toBe(202);
      expect(await valkey.zscore('mm:queue', user.userId)).not.toBeNull();
    } finally {
      spy.mockRestore();
      socket.terminate();
    }
  });

  it('대기 → 상대가 오면 둘 다 MATCH_FOUND, 기본 설정 방에서 바로 카운트다운', async () => {
    const a = await online();
    const b = await online();
    const res = await enqueue(a);
    expect(res.statusCode).toBe(202);
    const ticket = res.json();
    expect(new Date(ticket.timeoutAt).getTime() - new Date(ticket.queuedAt).getTime()).toBe(60_000);
    expect((await enqueue(a)).json().code).toBe('MATCH_ALREADY_QUEUED');

    expect((await enqueue(b)).statusCode).toBe(202);
    const found = await a.waitFor('MATCH_FOUND');
    expect((await b.waitFor('MATCH_FOUND')).payload).toEqual(found.payload);
    const { roomId, inviteCode } = found.payload as { roomId: string; inviteCode: string };
    const [room] = await db.select().from(battleRooms).where(eq(battleRooms.id, roomId));
    expect(room).toMatchObject({
      type: 'QUICK_MATCH',
      inviteCode,
      hostUserId: a.user.userId,
      packId: defaultPackId,
      questionType: 'KO_TO_EN_CHOICE',
      questionCount: 10,
      timeLimitSec: 10,
      maxParticipants: 2,
    });
    await a.waitFor('COUNTDOWN_STARTED');
    await b.waitFor('COUNTDOWN_STARTED');

    // 성사된 뒤 취소하면 대기실로 보낼 정보와 함께 409
    const cancel = await call(a.user, 'DELETE', '/battles/matchmaking');
    expect(cancel.json()).toMatchObject({
      code: 'MATCH_ALREADY_FOUND',
      detail: { roomId, inviteCode },
    });
    // 방에 들어가 있으니 다시 매칭할 수 없다
    expect((await enqueue(a)).json().code).toBe('ROOM_ALREADY_JOINED');
    a.send('ROOM_LEAVE', { roomId });
    b.send('ROOM_LEAVE', { roomId });
    await expect
      .poll(
        async () =>
          (await db.select().from(battleRooms).where(eq(battleRooms.id, roomId)))[0]?.status,
      )
      .toBe('EXPIRED');
  }, 30_000);

  it('누적 XP가 가장 가까운 대기자와 짝짓는다', async () => {
    const low = await online({ totalXp: 100 });
    const high = await online({ totalXp: 1000 });
    const near = await online({ totalXp: 900 });
    // 들어오자마자 짝지어지므로 둘 이상 기다리는 상황(차단 관계로 서로 못 만나는 경우 등)을 직접 만든다
    const now = Date.now();
    for (const waiter of [low, high]) {
      await valkey.zadd('mm:queue', waiter === low ? 100 : 1000, waiter.user.userId);
      await valkey.hset('mm:queued', waiter.user.userId, now);
    }
    await enqueue(near);
    const found = await near.waitFor('MATCH_FOUND');
    expect((await high.waitFor('MATCH_FOUND')).payload).toEqual(found.payload);
    expect(low.has('MATCH_FOUND')).toBe(false);
    expect(await valkey.zrange('mm:queue', '0', '-1')).toEqual([low.user.userId]);
    const { roomId } = found.payload as { roomId: string };
    near.send('ROOM_LEAVE', { roomId });
    high.send('ROOM_LEAVE', { roomId });
    await expect
      .poll(
        async () =>
          (await db.select().from(battleRooms).where(eq(battleRooms.id, roomId)))[0]?.status,
      )
      .toBe('EXPIRED');
  });

  it('연결이 끊긴 대기자와는 짝짓지 않고 다음 대기자를 본다', async () => {
    const gone = await makeUser({ totalXp: 500 });
    await valkey.zadd('mm:queue', 500, gone.userId);
    await valkey.hset('mm:queued', gone.userId, Date.now());
    const a = await online({ totalXp: 500 });
    expect((await enqueue(a)).statusCode).toBe(202);
    // 성사 처리는 응답 뒤에 이어지므로 끝날 때까지 기다린다
    await expect.poll(() => valkey.zrange('mm:queue', '0', '-1')).toEqual([a.user.userId]);
    expect(a.has('MATCH_FOUND')).toBe(false);
    expect(await valkey.get(`mm:found:${gone.userId}`)).toBeNull();
  });

  it('어느 쪽이든 차단했으면 짝짓지 않는다', async () => {
    const a = await online({ totalXp: 700 });
    const b = await online({ totalXp: 700 });
    await db.insert(blocks).values({ blockerId: a.user.userId, blockedId: b.user.userId });
    expect((await enqueue(a)).statusCode).toBe(202);
    expect((await enqueue(b)).statusCode).toBe(202);
    await expect
      .poll(async () => (await valkey.zrange('mm:queue', '0', '-1')).sort())
      .toEqual([a.user.userId, b.user.userId].sort());
    expect(a.has('MATCH_FOUND')).toBe(false);
    expect(b.has('MATCH_FOUND')).toBe(false);
  });

  it('성사되면 방을 만들기 전에 응답하고, 방 만들기에 실패하면 두 사람 모두 다시 줄 선다', async () => {
    const rooms = app.get(RoomsService);
    const create = rooms.createQuickMatch.bind(rooms);
    const slow = vi.spyOn(rooms, 'createQuickMatch').mockImplementation(async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return create(...args);
    });
    try {
      const a = await online();
      const b = await online();
      await enqueue(a);
      expect((await enqueue(b)).statusCode).toBe(202);
      // 방은 아직 만드는 중이다
      expect(b.has('MATCH_FOUND')).toBe(false);
      const found = await b.waitFor('MATCH_FOUND');
      const { roomId } = found.payload as { roomId: string };
      a.send('ROOM_LEAVE', { roomId });
      b.send('ROOM_LEAVE', { roomId });
    } finally {
      slow.mockRestore();
    }

    const broken = vi
      .spyOn(rooms, 'createQuickMatch')
      .mockRejectedValueOnce(new Error('DB 연결 실패'));
    try {
      const c = await online();
      const d = await online();
      await enqueue(c);
      expect((await enqueue(d)).statusCode).toBe(202);
      await expect
        .poll(async () => (await valkey.zrange('mm:queue', '0', '-1')).sort())
        .toEqual([c.user.userId, d.user.userId].sort());
      expect(d.has('MATCH_FOUND')).toBe(false);
    } finally {
      broken.mockRestore();
    }
  });

  it('성사 처리 중이면 다시 줄 서지 못하고, 남은 기록은 방에 있을 때만 믿는다', async () => {
    const a = await online();
    const foundKey = `mm:found:${a.user.userId}`;
    await valkey.set(foundKey, `PENDING:${Date.now()}`, 'EX', 120);
    expect((await enqueue(a)).json().code).toBe('MATCH_ALREADY_QUEUED');
    // 방을 만드는 중이면 잠깐 기다려 본 뒤 이미 성사된 것으로 답하고, 표시는 지우지 않는다
    const busy = await call(a.user, 'DELETE', '/battles/matchmaking');
    expect(busy.json()).toMatchObject({ code: 'MATCH_ALREADY_FOUND', detail: null });
    expect(await valkey.get(foundKey)).not.toBeNull();
    // 오래되어 끊긴 표시는 다시 줄 서는 것을 막지 않고, 취소하면 404와 함께 지운다
    await valkey.set(foundKey, `PENDING:${Date.now() - 31_000}`, 'EX', 120);
    expect((await call(a.user, 'DELETE', '/battles/matchmaking')).json().code).toBe(
      'MATCH_NOT_QUEUED',
    );
    expect(await valkey.get(foundKey)).toBeNull();
    await valkey.set(foundKey, `PENDING:${Date.now() - 31_000}`, 'EX', 120);
    expect((await enqueue(a)).statusCode).toBe(202);
    expect((await call(a.user, 'DELETE', '/battles/matchmaking')).statusCode).toBe(204);
    // 이미 끝난 방을 가리키는 기록도 404
    await valkey.set(
      foundKey,
      JSON.stringify({ roomId: newId(), inviteCode: 'ABCDEF' }),
      'EX',
      120,
    );
    expect((await call(a.user, 'DELETE', '/battles/matchmaking')).json().code).toBe(
      'MATCH_NOT_QUEUED',
    );
    // 만료 작업이 유실돼 남은 자기 대기는 새로 줄 서면 덮는다
    await valkey.zadd('mm:queue', 0, a.user.userId);
    await valkey.hset('mm:queued', a.user.userId, Date.now() - 61_000);
    expect((await enqueue(a)).statusCode).toBe(202);
  }, 15_000);

  it('취소: 대기 중이면 204, 없으면 404', async () => {
    const a = await online();
    await enqueue(a);
    expect((await call(a.user, 'DELETE', '/battles/matchmaking')).statusCode).toBe(204);
    expect((await call(a.user, 'DELETE', '/battles/matchmaking')).json().code).toBe(
      'MATCH_NOT_QUEUED',
    );
    expect(await valkey.zcard('mm:queue')).toBe(0);
  });

  it('60초가 지나면 MATCH_TIMEOUT, 만료된 대기자와는 짝짓지 않는다', async () => {
    const a = await online();
    const queuedAt = new Date((await enqueue(a)).json().queuedAt).getTime();
    const matchmaking = app.get(MatchmakingService);
    // 다시 줄을 선 경우의 옛 만료 작업은 무시
    await matchmaking.expire(a.user.userId, queuedAt - 1);
    expect(await valkey.zscore('mm:queue', a.user.userId)).not.toBeNull();
    await matchmaking.expire(a.user.userId, queuedAt);
    await a.waitFor('MATCH_TIMEOUT');
    expect(await valkey.zscore('mm:queue', a.user.userId)).toBeNull();

    // 만료 작업이 유실돼 남은 대기자는 짝지을 때 걸러진다
    const stale = await online();
    await enqueue(stale);
    await valkey.hset('mm:queued', stale.user.userId, Date.now() - 61_000);
    const fresh = await online();
    await enqueue(fresh);
    expect(fresh.has('MATCH_FOUND')).toBe(false);
    expect(await valkey.zrange('mm:queue', '0', '-1')).toEqual([fresh.user.userId]);
  });

  it('연결이 끊기거나 직접 방에 들어가면 대기열에서 빠진다', async () => {
    const a = await online();
    await enqueue(a);
    await a.close();
    await expect.poll(() => valkey.zscore('mm:queue', a.user.userId)).toBeNull();

    const b = await online();
    await enqueue(b);
    const host = await makeUser();
    const packId = (
      await inject(app, {
        method: 'POST',
        url: '/packs',
        payload: { name: `직접방 ${newId().slice(-6)}` },
        headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(host)}` },
      })
    ).json().packId as string;
    await inject(app, {
      method: 'POST',
      url: `/packs/${packId}/words`,
      payload: {
        words: Array.from({ length: 10 }, (_, i) => ({
          english: `room${i}`,
          meanings: [`방${i}`],
        })),
      },
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(host)}` },
    });
    const room = (
      await call(host, 'POST', '/battles/rooms', {
        packId,
        questionType: 'KO_TO_EN_CHOICE',
        questionCount: 10,
        timeLimitSec: 10,
        maxParticipants: 2,
      })
    ).json();
    expect((await call(b.user, 'POST', `/battles/rooms/${room.inviteCode}/join`)).statusCode).toBe(
      200,
    );
    expect(await valkey.zscore('mm:queue', b.user.userId)).toBeNull();
  });
});
