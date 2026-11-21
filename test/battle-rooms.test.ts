import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray, ne } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  battleRoomParticipants,
  battleRooms,
  classes,
  type NewUser,
  packs,
  teacherClasses,
  users,
  words,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { RealtimeService } from '../src/modules/realtime/realtime.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

type RoomBody = {
  roomId: string;
  inviteCode: string;
  status: string;
  participants: { user: { userId: string }; isHost: boolean }[];
};

describe('대결방 생성·조회·참가', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];
  let sent: ReturnType<typeof vi.spyOn>;

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `대결${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 1 : null,
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

  const createPack = async (user: AuthUser, count = 10) => {
    const packId = (
      await call(user, 'POST', '/packs', { name: `대결팩 ${newId().slice(-6)}` })
    ).json().packId as string;
    await call(user, 'POST', `/packs/${packId}/words`, {
      words: Array.from({ length: count }, (_, i) => ({
        english: `word${i}`,
        meanings: [`뜻${i}`],
      })),
    });
    return packId;
  };

  const settings = (packId: string, overrides: object = {}) => ({
    packId,
    questionType: 'KO_TO_EN_CHOICE',
    questionCount: 10,
    timeLimitSec: 10,
    maxParticipants: 4,
    ...overrides,
  });

  const createRoom = async (user: AuthUser, overrides: object = {}) => {
    const res = await call(
      user,
      'POST',
      '/battles/rooms',
      settings(await createPack(user), overrides),
    );
    expect(res.statusCode).toBe(201);
    return res.json() as RoomBody;
  };

  const join = (user: AuthUser, code: string) => call(user, 'POST', `/battles/rooms/${code}/join`);

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    sent = vi.spyOn(app.get(RealtimeService), 'sendToUsers');
  });

  afterAll(async () => {
    vi.restoreAllMocks();
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

  it('방을 만들면 만든 사람이 방장, 30분 뒤 만료, 단어보다 문항이 많으면 중복 출제', async () => {
    const host = await makeUser();
    const packId = await createPack(host);
    const res = await call(host, 'POST', '/battles/rooms', settings(packId, { questionCount: 20 }));
    expect(res.statusCode).toBe(201);
    const room = res.json();
    expect(room).toMatchObject({
      type: 'NORMAL',
      status: 'WAITING',
      hostUserId: host.userId,
      classId: null,
      settings: {
        packId,
        questionType: 'KO_TO_EN_CHOICE',
        questionCount: 20,
        timeLimitSec: 10,
        maxParticipants: 4,
      },
      participants: [{ user: { userId: host.userId }, isHost: true, state: 'CONNECTED' }],
      duplicateQuestions: true,
      battleId: null,
    });
    expect(room.inviteCode).toMatch(/^[A-Z0-9]{6}$/);
    expect(room.inviteUrl).toMatch(new RegExp(`/battle/rooms/${room.inviteCode}$`));
    const ttl = new Date(room.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000);

    // 사용자당 활성 방 하나
    const again = await call(host, 'POST', '/battles/rooms', settings(packId));
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      code: 'ROOM_ALREADY_JOINED',
      detail: { inviteCode: room.inviteCode },
    });

    const small = await makeUser();
    const tooFew = await call(
      small,
      'POST',
      '/battles/rooms',
      settings(await createPack(small, 9)),
    );
    expect(tooFew.json().code).toBe('BATTLE_PACK_TOO_FEW_WORDS');
    expect(
      (
        await call(
          small,
          'POST',
          '/battles/rooms',
          settings(packId, { questionType: 'EN_TO_KO_TYPING' }),
        )
      ).statusCode,
    ).toBe(400);
  });

  it('초대 코드로 조회·참가하고, 방에 있던 사람에게 알린다', async () => {
    const host = await makeUser();
    const guest = await makeUser();
    const room = await createRoom(host);

    expect((await call(guest, 'GET', `/battles/rooms/${room.inviteCode}`)).json().roomId).toBe(
      room.roomId,
    );
    expect((await call(guest, 'GET', '/battles/rooms/abc')).json().code).toBe(
      'ROOM_INVITE_CODE_INVALID',
    );
    expect((await call(guest, 'GET', '/battles/rooms/ZZZZZ9')).json().code).toBe('ROOM_NOT_FOUND');

    sent.mockClear();
    const joined = await join(guest, room.inviteCode);
    expect(joined.statusCode).toBe(200);
    expect(
      joined.json().participants.map((p: { user: { userId: string } }) => p.user.userId),
    ).toEqual([host.userId, guest.userId]);
    expect(sent).toHaveBeenCalledWith(
      [host.userId],
      'PARTICIPANT_JOINED',
      expect.objectContaining({ participant: expect.objectContaining({ isHost: false }) }),
    );

    // 이미 들어와 있으면 그대로, 알림은 다시 보내지 않는다
    sent.mockClear();
    expect((await join(guest, room.inviteCode)).statusCode).toBe(200);
    expect(sent).not.toHaveBeenCalled();

    // 다른 방에 있으면 참가할 수 없다
    const otherRoom = await createRoom(await makeUser());
    const blocked = await join(guest, otherRoom.inviteCode);
    expect(blocked.json()).toMatchObject({
      code: 'ROOM_ALREADY_JOINED',
      detail: { inviteCode: room.inviteCode },
    });
  });

  it('정원이 차면 409, 동시에 몰려도 남은 자리만큼만 들어간다', async () => {
    const host = await makeUser();
    const room = await createRoom(host, { maxParticipants: 3 });
    const crowd = await Promise.all(Array.from({ length: 5 }, () => makeUser()));
    const results = await Promise.all(crowd.map((u) => join(u, room.inviteCode)));
    const codes = results.map((r) => (r.statusCode === 200 ? 'OK' : r.json().code)).sort();
    expect(codes).toEqual(['OK', 'OK', 'ROOM_FULL', 'ROOM_FULL', 'ROOM_FULL']);
    expect(
      (await call(host, 'GET', `/battles/rooms/${room.inviteCode}`)).json().participants,
    ).toHaveLength(3);
  });

  it('코드를 5번 연달아 잘못 넣으면 1분 제한, 성공하면 다시 센다', async () => {
    const host = await makeUser();
    const room = await createRoom(host);
    const typo = await makeUser();
    for (let i = 0; i < 4; i++) await join(typo, 'NOPE01');
    expect((await join(typo, room.inviteCode)).statusCode).toBe(200);
    // 참가에 성공해서 다시 세므로, 4번 더 틀려도 막히지 않는다 (초기화가 안 됐다면 8번째부터 429)
    for (let i = 0; i < 4; i++) expect((await join(typo, 'NOPE01')).statusCode).toBe(404);
    expect((await join(typo, room.inviteCode)).statusCode).toBe(200);

    // 아는 옛날 코드(끝난 방)를 섞어 넣어도 초기화되지 않는다
    const prober = await makeUser();
    const ended = await createRoom(await makeUser());
    await db
      .update(battleRooms)
      .set({ status: 'FINISHED' })
      .where(eq(battleRooms.id, ended.roomId));
    for (let i = 0; i < 2; i++) await join(prober, 'NOPE03');
    expect((await join(prober, ended.inviteCode)).json().code).toBe('ROOM_NOT_FOUND');
    for (let i = 0; i < 2; i++) await join(prober, 'NOPE03');
    expect((await join(prober, room.inviteCode)).statusCode).toBe(429);

    // 조회로 코드를 찔러봐도 같이 센다
    const peeker = await makeUser();
    for (let i = 0; i < 5; i++) await call(peeker, 'GET', '/battles/rooms/NOPE04');
    expect((await call(peeker, 'GET', `/battles/rooms/${room.inviteCode}`)).statusCode).toBe(429);
    expect((await join(peeker, room.inviteCode)).statusCode).toBe(429);

    const careless = await makeUser();
    for (let i = 0; i < 4; i++) expect((await join(careless, 'NOPE02')).statusCode).toBe(404);
    expect((await join(careless, 'bad')).statusCode).toBe(400);
    const limited = await join(careless, room.inviteCode);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().code).toBe('ROOM_CODE_ATTEMPTS_EXCEEDED');
    expect(limited.headers['retry-after']).toBe('60');
  });

  it('강퇴된 방·시작한 방·만료된 방', async () => {
    const host = await makeUser();
    const room = await createRoom(host);
    const kicked = await makeUser();
    await join(kicked, room.inviteCode);
    await db
      .update(battleRoomParticipants)
      .set({ state: 'KICKED', active: false })
      .where(
        and(
          eq(battleRoomParticipants.roomId, room.roomId),
          eq(battleRoomParticipants.userId, kicked.userId),
        ),
      );
    expect((await join(kicked, room.inviteCode)).json().code).toBe('ROOM_KICKED');

    await db
      .update(battleRooms)
      .set({ status: 'IN_PROGRESS' })
      .where(eq(battleRooms.id, room.roomId));
    expect((await join(await makeUser(), room.inviteCode)).json().code).toBe(
      'ROOM_ALREADY_STARTED',
    );

    const lateHost = await makeUser();
    const stale = await createRoom(lateHost);
    await db
      .update(battleRooms)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(battleRooms.id, stale.roomId));
    sent.mockClear();
    expect(
      (await call(lateHost, 'GET', `/battles/rooms/${stale.inviteCode}`)).json(),
    ).toMatchObject({
      status: 'EXPIRED',
      participants: [],
    });
    expect(sent).toHaveBeenCalledWith([lateHost.userId], 'ROOM_CLOSED', { reason: 'EXPIRED' });
    expect((await join(await makeUser(), stale.inviteCode)).json().code).toBe('ROOM_NOT_FOUND');
  });

  it('만료되거나 끝난 방은 조회하지 않아도 사용자를 붙잡지 않는다', async () => {
    // 만료 시각이 지났는데 지연 작업이 아직 안 돈 방: 새 방을 만들 때 정리된다
    const overdueHost = await makeUser();
    const overdue = await createRoom(overdueHost);
    await db
      .update(battleRooms)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(battleRooms.id, overdue.roomId));
    await createRoom(overdueHost);
    const [closed] = await db
      .select({ status: battleRooms.status })
      .from(battleRooms)
      .where(eq(battleRooms.id, overdue.roomId));
    expect(closed?.status).toBe('EXPIRED');

    // 방은 끝났는데 참가 기록만 활성으로 남은 경우(예전 실패 등)도 풀어 준다
    const stuckHost = await makeUser();
    const stuck = await createRoom(stuckHost);
    await db.update(battleRooms).set({ status: 'EXPIRED' }).where(eq(battleRooms.id, stuck.roomId));
    await createRoom(stuckHost);
    const stuckGuest = await makeUser();
    const another = await createRoom(await makeUser());
    await db.insert(battleRoomParticipants).values({
      roomId: stuck.roomId,
      userId: stuckGuest.userId,
      joinedAt: new Date(),
    });
    expect((await join(stuckGuest, another.inviteCode)).statusCode).toBe(200);
  });

  it('교사용 반 방: 교사는 진행자, 그 반 학생만 들어온다', async () => {
    const [cls] = await db.select().from(classes).limit(1);
    const classId = cls?.id as string;
    const teacher = await makeUser({ role: 'TEACHER' });
    await db.insert(teacherClasses).values({ teacherId: teacher.userId, classId });
    const res = await call(
      teacher,
      'POST',
      `/classes/${classId}/rooms`,
      settings(await createPack(teacher)),
    );
    expect(res.statusCode).toBe(201);
    const room = res.json();
    expect(room).toMatchObject({
      type: 'CLASS',
      hostUserId: teacher.userId,
      classId,
      participants: [],
    });

    const mine = await makeUser({ grade: cls?.grade, classNo: cls?.classNo });
    expect((await join(mine, room.inviteCode)).statusCode).toBe(200);
    const outsider = await makeUser({ grade: cls?.grade, classNo: (cls?.classNo ?? 1) + 1 });
    expect((await join(outsider, room.inviteCode)).json().code).toBe('ROOM_CLASS_ONLY');

    const second = await call(
      teacher,
      'POST',
      `/classes/${classId}/rooms`,
      settings(await createPack(teacher)),
    );
    expect(second.json().code).toBe('ROOM_ALREADY_JOINED');

    // 동시에 두 번 만들어도 진행 중인 반 방은 하나
    const busy = await makeUser({ role: 'TEACHER' });
    await db.insert(teacherClasses).values({ teacherId: busy.userId, classId });
    const busyPack = await createPack(busy);
    const pair = await Promise.all([
      call(busy, 'POST', `/classes/${classId}/rooms`, settings(busyPack)),
      call(busy, 'POST', `/classes/${classId}/rooms`, settings(busyPack)),
    ]);
    expect(pair.map((r) => r.statusCode).sort()).toEqual([201, 409]);

    const [otherClass] = await db.select().from(classes).where(ne(classes.id, classId)).limit(1);
    const notMine = await call(
      teacher,
      'POST',
      `/classes/${otherClass?.id}/rooms`,
      settings(await createPack(teacher)),
    );
    expect(notMine.statusCode).toBe(403);
    // 학생은 반 방을 만들 수 없고, 교사는 일반 방을 만들 수 없다
    expect(
      (await call(mine, 'POST', `/classes/${classId}/rooms`, settings(await createPack(mine))))
        .statusCode,
    ).toBe(403);
    expect(
      (await call(teacher, 'POST', '/battles/rooms', settings(await createPack(teacher))))
        .statusCode,
    ).toBe(403);
  });
});
