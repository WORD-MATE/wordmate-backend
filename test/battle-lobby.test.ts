import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  battleRoomParticipants,
  battleRooms,
  blocks,
  classes,
  type NewUser,
  packs,
  teacherClasses,
  users,
  words,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { createTestApp, inject } from './support/create-test-app.js';
import { connectAs, type WsClient } from './support/ws-client.js';

type Room = { roomId: string; inviteCode: string };

describe('대결 대기실', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];
  const clients: WsClient[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `대기${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 2 : null,
      classNo: role === 'STUDENT' ? 2 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: false, deviceId: newId() };
  };

  const call = async (user: AuthUser, method: 'GET' | 'POST', url: string, payload?: object) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const createPack = async (user: AuthUser) => {
    const packId = (
      await call(user, 'POST', '/packs', { name: `대기팩 ${newId().slice(-6)}` })
    ).json().packId as string;
    await call(user, 'POST', `/packs/${packId}/words`, {
      words: Array.from({ length: 10 }, (_, i) => ({ english: `word${i}`, meanings: [`뜻${i}`] })),
    });
    return packId;
  };

  const settings = (packId: string) => ({
    packId,
    questionType: 'KO_TO_EN_CHOICE',
    questionCount: 10,
    timeLimitSec: 10,
    maxParticipants: 4,
  });

  /** 방장이 방을 만들고 guests가 참가한 뒤, 모두 접속해 구독한다 */
  const setup = async (guestCount: number) => {
    const host = await makeUser();
    const room = (
      await call(host, 'POST', '/battles/rooms', settings(await createPack(host)))
    ).json() as Room;
    const guests = await Promise.all(Array.from({ length: guestCount }, () => makeUser()));
    for (const guest of guests) {
      expect((await call(guest, 'POST', `/battles/rooms/${room.inviteCode}/join`)).statusCode).toBe(
        200,
      );
    }
    const all = await Promise.all([host, ...guests].map((u) => connectAs(app, u)));
    clients.push(...all);
    for (const client of all) {
      client.send('ROOM_SUBSCRIBE', { roomId: room.roomId });
      await client.waitFor('ROOM_STATE');
    }
    const [hostClient, ...guestClients] = all as [WsClient, ...WsClient[]];
    return { room, host: hostClient, guests: guestClients };
  };

  const join = (user: AuthUser, code: string) => call(user, 'POST', `/battles/rooms/${code}/join`);
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const roomStatusOf = (client: WsClient) =>
    client.received
      .filter((m) => m.type === 'ROOM_STATE')
      .map((m) => (m.payload.room as { status: string }).status);

  const roomRow = async (roomId: string) =>
    (await db.select().from(battleRooms).where(eq(battleRooms.id, roomId)))[0];

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    for (const client of clients) client.socket.terminate();
    await db.delete(blocks).where(inArray(blocks.blockerId, userIds));
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
    await db.delete(teacherClasses).where(inArray(teacherClasses.teacherId, userIds));
    const owned = await db
      .select({ id: packs.id })
      .from(packs)
      .where(inArray(packs.ownerUserId, userIds));
    const ids = owned.map((row) => row.id);
    if (ids.length > 0) {
      await db.delete(words).where(inArray(words.packId, ids));
      await db.delete(packs).where(inArray(packs.id, ids));
    }
    await app.close();
  });

  it('구독하면 방 전체 상태를 받고, 참가자가 아니면 거절한다', async () => {
    const { room, host } = await setup(1);
    const state = host.received.find((m) => m.type === 'ROOM_STATE');
    expect(state?.payload.room).toMatchObject({ roomId: room.roomId, status: 'WAITING' });

    const outsider = await connectAs(app, await makeUser());
    clients.push(outsider);
    outsider.send('ROOM_SUBSCRIBE', { roomId: room.roomId }, 'r1');
    expect((await outsider.waitFor('ERROR')).payload).toMatchObject({ code: 'ROOM_NOT_MEMBER' });
    outsider.send('ROOM_SUBSCRIBE', { roomId: 'not-a-uuid' });
    await outsider.waitFor('ERROR', { code: 'INVALID_REQUEST' });
  });

  it('연결이 끊기면 DISCONNECTED, 다시 구독하면 CONNECTED (방에서는 나가지 않는다)', async () => {
    const { room, host, guests } = await setup(1);
    const guest = guests[0] as WsClient;
    await guest.close();
    await host.waitFor('PARTICIPANT_STATE', { userId: guest.user.userId, state: 'DISCONNECTED' });

    const back = await connectAs(app, guest.user);
    clients.push(back);
    back.send('ROOM_SUBSCRIBE', { roomId: room.roomId });
    await back.waitFor('ROOM_STATE');
    await host.waitFor('PARTICIPANT_STATE', { userId: guest.user.userId, state: 'CONNECTED' });
  });

  it('방장이 나가면 가장 먼저 들어온 참가자가 방장, 모두 나가면 방이 닫힌다', async () => {
    const { room, host, guests } = await setup(2);
    const [first, second] = guests as [WsClient, WsClient];
    host.send('ROOM_LEAVE', { roomId: room.roomId });
    await first.waitFor('PARTICIPANT_STATE', { userId: host.user.userId, state: 'LEFT' });
    expect((await second.waitFor('HOST_CHANGED')).payload).toEqual({
      hostUserId: first.user.userId,
    });
    expect((await roomRow(room.roomId))?.hostUserId).toBe(first.user.userId);

    first.send('ROOM_LEAVE', { roomId: room.roomId });
    await second.waitFor('HOST_CHANGED', { hostUserId: second.user.userId });
    second.send('ROOM_LEAVE', { roomId: room.roomId });
    await expect.poll(async () => (await roomRow(room.roomId))?.status).toBe('EXPIRED');
  });

  it('방장만 대기실에서 강퇴하고, 강퇴된 사람은 다시 못 들어온다', async () => {
    const { room, host, guests } = await setup(2);
    const [target, other] = guests as [WsClient, WsClient];
    other.send('ROOM_KICK', { roomId: room.roomId, userId: target.user.userId });
    await other.waitFor('ERROR', { code: 'ROOM_NOT_HOST' });
    host.send('ROOM_KICK', { roomId: room.roomId, userId: host.user.userId });
    await host.waitFor('ERROR', { code: 'ROOM_KICK_TARGET_INVALID' });

    host.send('ROOM_KICK', { roomId: room.roomId, userId: target.user.userId });
    expect((await target.waitFor('ROOM_CLOSED')).payload).toEqual({ reason: 'KICKED' });
    await other.waitFor('PARTICIPANT_STATE', { userId: target.user.userId, state: 'KICKED' });
    expect(target.has('PARTICIPANT_STATE', { userId: target.user.userId, state: 'KICKED' })).toBe(
      false,
    );
    expect(
      (await call(target.user, 'POST', `/battles/rooms/${room.inviteCode}/join`)).json().code,
    ).toBe('ROOM_KICKED');
  });

  it('방장이 2명 이상일 때 시작하면 3초 카운트다운 뒤 진행 중이 된다', async () => {
    const solo = await setup(0);
    solo.host.send('ROOM_START', { roomId: solo.room.roomId });
    await solo.host.waitFor('ERROR', { code: 'ROOM_NOT_ENOUGH_PARTICIPANTS' });

    const { room, host, guests } = await setup(1);
    const guest = guests[0] as WsClient;
    guest.send('ROOM_START', { roomId: room.roomId });
    await guest.waitFor('ERROR', { code: 'ROOM_NOT_HOST' });

    host.send('ROOM_START', { roomId: room.roomId });
    const countdown = await guest.waitFor('COUNTDOWN_STARTED');
    const startsIn = new Date(countdown.payload.startsAt as string).getTime() - Date.now();
    expect(startsIn).toBeGreaterThan(1000);
    expect(startsIn).toBeLessThanOrEqual(3000);
    expect(
      (await call(await makeUser(), 'POST', `/battles/rooms/${room.inviteCode}/join`)).json().code,
    ).toBe('ROOM_ALREADY_STARTED');

    // 구독할 때 받은 상태 말고, 카운트다운이 끝난 뒤의 새 상태를 기다린다
    await expect.poll(() => roomStatusOf(host), { timeout: 8000 }).toContain('IN_PROGRESS');
    expect(roomStatusOf(guest)).toContain('IN_PROGRESS');
    expect((await roomRow(room.roomId))?.status).toBe('IN_PROGRESS');
  });

  it('카운트다운 중에 인원이 모자라면 취소되고 대기실로 돌아간다', async () => {
    const { room, host, guests } = await setup(1);
    host.send('ROOM_START', { roomId: room.roomId });
    await host.waitFor('COUNTDOWN_STARTED');
    (guests[0] as WsClient).send('ROOM_LEAVE', { roomId: room.roomId });
    expect((await host.waitFor('COUNTDOWN_CANCELLED')).payload).toEqual({
      reason: 'NOT_ENOUGH_PARTICIPANTS',
    });
    // 예약된 시작 작업이 돌아도 대기실 그대로
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect((await roomRow(room.roomId))?.status).toBe('WAITING');
  });

  it('취소 뒤 다시 시작하면 예전 카운트다운의 작업은 무시된다', async () => {
    const { room, host, guests } = await setup(1);
    const guest = guests[0] as WsClient;
    const firstStart = Date.now();
    host.send('ROOM_START', { roomId: room.roomId });
    await host.waitFor('COUNTDOWN_STARTED');
    guest.send('ROOM_LEAVE', { roomId: room.roomId });
    await host.waitFor('COUNTDOWN_CANCELLED');
    expect((await join(guest.user, room.inviteCode)).statusCode).toBe(200);

    await sleep(Math.max(0, firstStart + 1500 - Date.now()));
    host.send('ROOM_START', { roomId: room.roomId });
    await expect
      .poll(() => host.received.filter((m) => m.type === 'COUNTDOWN_STARTED').length)
      .toBe(2);
    // 예전 작업(처음 시작 3초 뒤)이 돈 뒤에도 아직 카운트다운이어야 한다
    await sleep(Math.max(0, firstStart + 3800 - Date.now()));
    expect((await roomRow(room.roomId))?.status).toBe('COUNTDOWN');
    await expect
      .poll(async () => (await roomRow(room.roomId))?.status, { timeout: 8000 })
      .toBe('IN_PROGRESS');
  });

  it('진행 중에도 나갈 수 있고, 나간 사람은 새 방을 만들 수 있다', async () => {
    const { room, host, guests } = await setup(2);
    const [leaver, stayer] = guests as [WsClient, WsClient];
    host.send('ROOM_START', { roomId: room.roomId });
    await expect.poll(() => roomStatusOf(host), { timeout: 8000 }).toContain('IN_PROGRESS');

    leaver.send('ROOM_LEAVE', { roomId: room.roomId });
    await stayer.waitFor('PARTICIPANT_STATE', { userId: leaver.user.userId, state: 'LEFT' });
    expect(
      (await call(leaver.user, 'POST', '/battles/rooms', settings(await createPack(leaver.user))))
        .statusCode,
    ).toBe(201);

    host.send('ROOM_LEAVE', { roomId: room.roomId });
    await stayer.waitFor('HOST_CHANGED', { hostUserId: stayer.user.userId });
  });

  it('나갔다 다시 들어온 옛 방장에게는 방장 표시가 남지 않는다', async () => {
    const { room, host, guests } = await setup(1);
    const guest = guests[0] as WsClient;
    host.send('ROOM_LEAVE', { roomId: room.roomId });
    await guest.waitFor('HOST_CHANGED', { hostUserId: guest.user.userId });
    expect((await join(host.user, room.inviteCode)).statusCode).toBe(200);

    const hosts = await db
      .select({ userId: battleRoomParticipants.userId })
      .from(battleRoomParticipants)
      .where(
        and(
          eq(battleRoomParticipants.roomId, room.roomId),
          eq(battleRoomParticipants.isHost, true),
        ),
      );
    expect(hosts).toEqual([{ userId: guest.user.userId }]);

    // 옛 방장이 나가도 방장은 그대로
    host.send('ROOM_LEAVE', { roomId: room.roomId });
    await guest.waitFor('PARTICIPANT_STATE', { userId: host.user.userId, state: 'LEFT' });
    expect(guest.has('HOST_CHANGED', { hostUserId: host.user.userId })).toBe(false);
    expect((await roomRow(room.roomId))?.hostUserId).toBe(guest.user.userId);
  });

  it('멈춘 방은 참가할 때 정리된다 (멈춘 카운트다운은 대기실로, 오래 진행 중인 방은 닫힘)', async () => {
    const stalled = await setup(1);
    await db
      .update(battleRooms)
      .set({ status: 'COUNTDOWN', countdownEndsAt: new Date(Date.now() - 60_000) })
      .where(eq(battleRooms.id, stalled.room.roomId));
    const other = await setup(0);
    // 아직 대기실 방에 있으므로 참가는 거절되지만, 멈춘 카운트다운은 풀린다
    expect((await join(stalled.host.user, other.room.inviteCode)).json().code).toBe(
      'ROOM_ALREADY_JOINED',
    );
    const recovered = await roomRow(stalled.room.roomId);
    expect(recovered).toMatchObject({ status: 'WAITING', countdownEndsAt: null });
    for (const client of [stalled.host, ...stalled.guests]) {
      expect((await client.waitFor('COUNTDOWN_CANCELLED')).payload).toEqual({
        reason: 'START_FAILED',
      });
    }

    await db
      .update(battleRooms)
      .set({ status: 'IN_PROGRESS', startedAt: new Date(Date.now() - 31 * 60_000) })
      .where(eq(battleRooms.id, stalled.room.roomId));
    const guest = stalled.guests[0] as WsClient;
    expect((await join(guest.user, other.room.inviteCode)).statusCode).toBe(200);
    expect((await guest.waitFor('ROOM_CLOSED')).payload).toEqual({ reason: 'EXPIRED' });
    expect((await roomRow(stalled.room.roomId))?.status).toBe('EXPIRED');
  });

  it('리액션은 다른 사람에게만, 3초에 한 번', async () => {
    const { room, host, guests } = await setup(1);
    const guest = guests[0] as WsClient;
    guest.send('REACTION_SEND', { roomId: room.roomId, reaction: 'FIRE' });
    expect((await host.waitFor('REACTION_RECEIVED')).payload).toEqual({
      userId: guest.user.userId,
      reaction: 'FIRE',
    });
    guest.send('REACTION_SEND', { roomId: room.roomId, reaction: 'CLAP' });
    await guest.waitFor('ERROR', { code: 'RATE_LIMITED' });
    expect(guest.has('REACTION_RECEIVED')).toBe(false);
    guest.send('REACTION_SEND', { roomId: room.roomId, reaction: 'NOPE' });
    await guest.waitFor('ERROR', { code: 'INVALID_REQUEST' });
  });

  it('보낸 사람을 차단한 사람은 리액션을 받지 않는다', async () => {
    const { room, host, guests } = await setup(2);
    const [sender, other] = guests as [WsClient, WsClient];
    await db.insert(blocks).values({ blockerId: host.user.userId, blockedId: sender.user.userId });
    sender.send('REACTION_SEND', { roomId: room.roomId, reaction: 'FIRE' });
    expect((await other.waitFor('REACTION_RECEIVED')).payload).toEqual({
      userId: sender.user.userId,
      reaction: 'FIRE',
    });
    expect(host.has('REACTION_RECEIVED')).toBe(false);
  });

  it('교사용 반 방: 교사가 진행하고, 교사가 나가면 방이 닫힌다', async () => {
    const [cls] = await db.select().from(classes).limit(1);
    const classId = cls?.id as string;
    const teacher = await makeUser({ role: 'TEACHER' });
    await db.insert(teacherClasses).values({ teacherId: teacher.userId, classId });
    const room = (
      await call(teacher, 'POST', `/classes/${classId}/rooms`, settings(await createPack(teacher)))
    ).json() as Room;
    const students = await Promise.all(
      [0, 1].map(() => makeUser({ grade: cls?.grade, classNo: cls?.classNo })),
    );
    for (const s of students) expect((await join(s, room.inviteCode)).statusCode).toBe(200);

    const host = await connectAs(app, teacher);
    const kids = await Promise.all(students.map((s) => connectAs(app, s)));
    clients.push(host, ...kids);
    for (const c of [host, ...kids]) {
      c.send('ROOM_SUBSCRIBE', { roomId: room.roomId });
      await c.waitFor('ROOM_STATE');
    }
    host.send('ROOM_LEAVE', { roomId: room.roomId });
    for (const kid of kids) {
      expect((await kid.waitFor('ROOM_CLOSED')).payload).toEqual({ reason: 'HOST_LEFT' });
    }
    expect((await roomRow(room.roomId))?.status).toBe('EXPIRED');

    // 교사가 진행하던 방이 멈춰 있어도 새 반 방을 만들 수 있다
    const stuck = (
      await call(teacher, 'POST', `/classes/${classId}/rooms`, settings(await createPack(teacher)))
    ).json() as Room;
    await db
      .update(battleRooms)
      .set({ status: 'IN_PROGRESS', startedAt: new Date(Date.now() - 31 * 60_000) })
      .where(eq(battleRooms.id, stuck.roomId));
    expect(
      (
        await call(
          teacher,
          'POST',
          `/classes/${classId}/rooms`,
          settings(await createPack(teacher)),
        )
      ).statusCode,
    ).toBe(201);
    expect((await roomRow(stuck.roomId))?.status).toBe('EXPIRED');

    // 닫힌 방은 사용자를 붙잡지 않는다
    expect(
      (
        await call(
          students[0] as AuthUser,
          'POST',
          '/battles/rooms',
          settings(await createPack(students[0] as AuthUser)),
        )
      ).statusCode,
    ).toBe(201);
  });
});
