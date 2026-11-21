import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, count, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  battleAnswers,
  battleQuestions,
  battleRoomParticipants,
  battleRooms,
  battles,
  classes,
  type NewUser,
  packs,
  teacherClasses,
  users,
  words,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { LobbyService } from '../src/modules/battles/lobby.service.js';
import { createTestApp, inject } from './support/create-test-app.js';
import { connectAs, type WsClient } from './support/ws-client.js';

type Room = { roomId: string; inviteCode: string };
type Ranked = { userId: string; rank: number; score: number };
type MyResult = {
  choiceIndex: number | null;
  correct: boolean;
  score: number;
  totalScore: number;
  rank: number;
};

const QUESTION_WAIT = 9000;

describe('대결 문항 진행', () => {
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
      name: `진행${userId.slice(-4)}`,
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
      await call(user, 'POST', '/packs', { name: `진행팩 ${newId().slice(-6)}` })
    ).json().packId as string;
    await call(user, 'POST', `/packs/${packId}/words`, {
      words: Array.from({ length: 10 }, (_, i) => ({
        english: `play${i}`,
        meanings: [`진행${i}`],
      })),
    });
    return packId;
  };

  const settings = (packId: string) => ({
    packId,
    questionType: 'KO_TO_EN_CHOICE',
    questionCount: 10,
    timeLimitSec: 5,
    maxParticipants: 4,
  });

  const subscribeAll = async (roomId: string, users: AuthUser[]) => {
    const all = await Promise.all(users.map((u) => connectAs(app, u)));
    clients.push(...all);
    for (const client of all) {
      client.send('ROOM_SUBSCRIBE', { roomId });
      await client.waitFor('ROOM_STATE');
    }
    return all;
  };

  /** 방을 만들고 guests가 참가해 구독한 뒤 방장이 시작해 첫 문항까지 기다린다 */
  const startBattle = async (guestCount: number) => {
    const hostUser = await makeUser();
    const room = (
      await call(hostUser, 'POST', '/battles/rooms', settings(await createPack(hostUser)))
    ).json() as Room;
    const guestUsers = await Promise.all(Array.from({ length: guestCount }, () => makeUser()));
    for (const guest of guestUsers) {
      expect((await call(guest, 'POST', `/battles/rooms/${room.inviteCode}/join`)).statusCode).toBe(
        200,
      );
    }
    const [host, ...guests] = (await subscribeAll(room.roomId, [hostUser, ...guestUsers])) as [
      WsClient,
      ...WsClient[],
    ];
    host.send('ROOM_START', { roomId: room.roomId });
    for (const client of [host, ...guests]) {
      await client.waitFor('QUESTION_STARTED', { questionIndex: 0 }, QUESTION_WAIT);
    }
    return { room, host, guests };
  };

  const answerIndexOf = async (roomId: string, idx: number) => {
    const [row] = await db
      .select({ answerIndex: battleQuestions.answerIndex })
      .from(battleQuestions)
      .innerJoin(battles, eq(battles.id, battleQuestions.battleId))
      .where(and(eq(battles.roomId, roomId), eq(battleQuestions.idx, idx)));
    return row?.answerIndex as number;
  };

  const participantOf = async (roomId: string, userId: string) =>
    (
      await db
        .select()
        .from(battleRoomParticipants)
        .where(
          and(eq(battleRoomParticipants.roomId, roomId), eq(battleRoomParticipants.userId, userId)),
        )
    )[0];

  const roomRow = async (roomId: string) =>
    (await db.select().from(battleRooms).where(eq(battleRooms.id, roomId)))[0];

  const myResult = (client: WsClient, idx: number) =>
    client.received.find((m) => m.type === 'QUESTION_ENDED' && m.payload.questionIndex === idx)
      ?.payload.myResult as MyResult | null | undefined;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    for (const client of clients) client.socket.terminate();
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

  it('끝까지: 문항마다 판정·결과를 보내고, 마지막 문항 뒤 BATTLE_FINISHED', async () => {
    const { room, host, guests } = await startBattle(1);
    const guest = guests[0] as WsClient;

    const first = host.received.find((m) => m.type === 'QUESTION_STARTED');
    expect(first?.payload).toMatchObject({ questionIndex: 0, total: 10 });
    expect(first?.payload.choices).toHaveLength(4);
    expect(typeof first?.payload.prompt).toBe('string');
    const answerWindow =
      new Date(first?.payload.deadlineAt as string).getTime() -
      new Date(first?.serverTime as string).getTime();
    expect(answerWindow).toBeGreaterThan(4000);
    expect(answerWindow).toBeLessThanOrEqual(5000);

    for (let i = 0; i < 10; i++) {
      await host.waitFor('QUESTION_STARTED', { questionIndex: i }, QUESTION_WAIT);
      await guest.waitFor('QUESTION_STARTED', { questionIndex: i }, QUESTION_WAIT);
      const answer = await answerIndexOf(room.roomId, i);
      host.send('ANSWER_SUBMIT', { questionIndex: i, choiceIndex: answer });
      await host.waitFor('ANSWER_ACCEPTED', { questionIndex: i });
      if (i === 0) {
        host.send('ANSWER_SUBMIT', { questionIndex: 0, choiceIndex: answer });
        await host.waitFor('ERROR', { code: 'ANSWER_ALREADY_SUBMITTED' });
        host.send('ANSWER_SUBMIT', { questionIndex: 5, choiceIndex: 0 });
        await host.waitFor('ERROR', { code: 'ANSWER_CLOSED' });
        host.send('ANSWER_SUBMIT', { questionIndex: 0, choiceIndex: 4 });
        await host.waitFor('ERROR', { code: 'INVALID_REQUEST' });
      }
      guest.send('ANSWER_SUBMIT', { questionIndex: i, choiceIndex: (answer + 1) % 4 });

      // 둘 다 답했으니 마감 전에 끝난다
      const ended = await host.waitFor('QUESTION_ENDED', { questionIndex: i }, 4000);
      await guest.waitFor('QUESTION_ENDED', { questionIndex: i }, 4000);
      expect(ended.payload.answerIndex).toBe(answer);
      const mine = myResult(host, i) as MyResult;
      expect(mine).toMatchObject({ choiceIndex: answer, correct: true, rank: 1 });
      expect(mine.score).toBeGreaterThanOrEqual(100);
      expect(mine.score).toBeLessThanOrEqual(150);
      expect(myResult(guest, i)).toMatchObject({
        correct: false,
        score: 0,
        totalScore: 0,
        rank: 2,
      });
      const ranking = ended.payload.ranking as Ranked[];
      expect(ranking.map((r) => [r.userId, r.rank])).toEqual([
        [host.user.userId, 1],
        [guest.user.userId, 2],
      ]);
      expect(ranking[0]?.score).toBe(mine.totalScore);
    }

    const finished = await host.waitFor('BATTLE_FINISHED', {}, QUESTION_WAIT);
    await guest.waitFor('BATTLE_FINISHED', { battleId: finished.payload.battleId });
    expect(await roomRow(room.roomId)).toMatchObject({ status: 'FINISHED' });
    const [battle] = await db.select().from(battles).where(eq(battles.roomId, room.roomId));
    expect(battle).toMatchObject({ id: finished.payload.battleId, phase: 'FINISHED' });
    const [answers] = await db
      .select({ total: count() })
      .from(battleAnswers)
      .where(eq(battleAnswers.battleId, battle?.id as string));
    expect(answers?.total).toBe(20);
    const view = (await call(host.user, 'GET', `/battles/rooms/${room.inviteCode}`)).json();
    expect(view).toMatchObject({ status: 'FINISHED', battleId: battle?.id });
    // 끝난 방은 사용자를 붙잡지 않는다
    expect(
      (await call(host.user, 'POST', '/battles/rooms', settings(await createPack(host.user))))
        .statusCode,
    ).toBe(201);
  }, 90_000);

  it('마감까지 답하지 않으면 미응답 0점, 진행 중 나가면 남은 사람끼리 바로 다음으로', async () => {
    const { room, host, guests } = await startBattle(1);
    const guest = guests[0] as WsClient;
    host.send('ANSWER_SUBMIT', {
      questionIndex: 0,
      choiceIndex: await answerIndexOf(room.roomId, 0),
    });
    await guest.waitFor('QUESTION_ENDED', { questionIndex: 0 }, QUESTION_WAIT);
    expect(myResult(guest, 0)).toEqual({
      choiceIndex: null,
      correct: false,
      score: 0,
      totalScore: 0,
      rank: 2,
    });

    await host.waitFor('QUESTION_STARTED', { questionIndex: 1 }, 5000);
    host.send('ANSWER_SUBMIT', {
      questionIndex: 1,
      choiceIndex: await answerIndexOf(room.roomId, 1),
    });
    await host.waitFor('ANSWER_ACCEPTED', { questionIndex: 1 });
    guest.send('ROOM_LEAVE', { roomId: room.roomId });
    // 마감(5초)보다 빨리 끝나야 한다
    const ended = await host.waitFor('QUESTION_ENDED', { questionIndex: 1 }, 3000);
    expect((ended.payload.ranking as Ranked[]).map((r) => r.userId)).toEqual([host.user.userId]);
    expect(await participantOf(room.roomId, guest.user.userId)).toMatchObject({
      state: 'LEFT',
      active: false,
    });
    expect(
      (await call(guest.user, 'POST', '/battles/rooms', settings(await createPack(guest.user))))
        .statusCode,
    ).toBe(201);

    host.send('ROOM_LEAVE', { roomId: room.roomId });
    await expect.poll(async () => (await roomRow(room.roomId))?.status).toBe('EXPIRED');
  }, 60_000);

  it('끊겼다가 ROOM_RESUME하면 진행 중인 문항부터 이어서 답한다', async () => {
    const { room, host, guests } = await startBattle(1);
    const guest = guests[0] as WsClient;
    const hostQuestion = host.received.find((m) => m.type === 'QUESTION_STARTED');
    await guest.close();
    await host.waitFor('PARTICIPANT_STATE', { userId: guest.user.userId, state: 'DISCONNECTED' });
    expect((await participantOf(room.roomId, guest.user.userId))?.disconnectedAt).toBeInstanceOf(
      Date,
    );

    const back = await connectAs(app, guest.user);
    clients.push(back);
    back.send('ROOM_RESUME', { roomId: room.roomId });
    const state = await back.waitFor('ROOM_STATE');
    expect(state.payload.room).toMatchObject({ status: 'IN_PROGRESS' });
    expect(typeof (state.payload.room as { battleId: unknown }).battleId).toBe('string');
    const resumed = await back.waitFor('QUESTION_STARTED');
    expect(resumed.payload).toEqual(hostQuestion?.payload);
    await host.waitFor('PARTICIPANT_STATE', { userId: guest.user.userId, state: 'CONNECTED' });
    expect((await participantOf(room.roomId, guest.user.userId))?.disconnectedAt).toBeNull();

    back.send('ANSWER_SUBMIT', { questionIndex: 0, choiceIndex: 0 });
    await back.waitFor('ANSWER_ACCEPTED', { questionIndex: 0 });
    // 다시 이어 받아도 이미 답한 것까지 알려 준다
    back.received.length = 0;
    back.send('ROOM_RESUME', { roomId: room.roomId });
    await back.waitFor('QUESTION_STARTED', { questionIndex: 0 });
    await back.waitFor('ANSWER_ACCEPTED', { questionIndex: 0 });

    host.send('ROOM_LEAVE', { roomId: room.roomId });
    back.send('ROOM_LEAVE', { roomId: room.roomId });
    await expect.poll(async () => (await roomRow(room.roomId))?.status).toBe('EXPIRED');
  }, 60_000);

  it('끊긴 지 유예 시간이 지나면 LEFT (그사이 다시 끊긴 경우의 옛 유예는 무시)', async () => {
    const { room, host, guests } = await startBattle(1);
    const guest = guests[0] as WsClient;
    await guest.close();
    await host.waitFor('PARTICIPANT_STATE', { userId: guest.user.userId, state: 'DISCONNECTED' });
    const disconnectedAt = (await participantOf(room.roomId, guest.user.userId))
      ?.disconnectedAt as Date;

    const lobby = app.get(LobbyService);
    await lobby.expireGrace(room.roomId, guest.user.userId, new Date(disconnectedAt.getTime() - 1));
    expect(await participantOf(room.roomId, guest.user.userId)).toMatchObject({
      state: 'DISCONNECTED',
      active: true,
    });
    await lobby.expireGrace(room.roomId, guest.user.userId, disconnectedAt);
    await host.waitFor('PARTICIPANT_STATE', { userId: guest.user.userId, state: 'LEFT' });

    // 남은 사람이 답하면 바로 끝난다
    host.send('ANSWER_SUBMIT', { questionIndex: 0, choiceIndex: 0 });
    await host.waitFor('QUESTION_ENDED', { questionIndex: 0 }, 3000);

    const back = await connectAs(app, guest.user);
    clients.push(back);
    back.send('ROOM_RESUME', { roomId: room.roomId });
    await back.waitFor('ERROR', { code: 'ROOM_NOT_MEMBER' });

    host.send('ROOM_LEAVE', { roomId: room.roomId });
    await expect.poll(async () => (await roomRow(room.roomId))?.status).toBe('EXPIRED');
  }, 60_000);

  it('교사용 반 방: 진행자는 문항·결과를 받지만 답할 수 없고, 학생이 모두 나가면 방이 닫힌다', async () => {
    const [cls] = await db.select().from(classes).limit(1);
    const classId = cls?.id as string;
    const teacherUser = await makeUser({ role: 'TEACHER' });
    await db.insert(teacherClasses).values({ teacherId: teacherUser.userId, classId });
    const room = (
      await call(
        teacherUser,
        'POST',
        `/classes/${classId}/rooms`,
        settings(await createPack(teacherUser)),
      )
    ).json() as Room;
    const studentUsers = await Promise.all(
      [0, 1].map(() => makeUser({ grade: cls?.grade, classNo: cls?.classNo })),
    );
    for (const s of studentUsers) {
      expect((await call(s, 'POST', `/battles/rooms/${room.inviteCode}/join`)).statusCode).toBe(
        200,
      );
    }
    const [teacher, ...students] = (await subscribeAll(room.roomId, [
      teacherUser,
      ...studentUsers,
    ])) as [WsClient, ...WsClient[]];
    teacher.send('ROOM_START', { roomId: room.roomId });
    await teacher.waitFor('QUESTION_STARTED', { questionIndex: 0 }, QUESTION_WAIT);
    teacher.send('ANSWER_SUBMIT', { questionIndex: 0, choiceIndex: 0 });
    await teacher.waitFor('ERROR', { code: 'BATTLE_NOT_IN_PROGRESS' });

    for (const s of students) {
      await s.waitFor('QUESTION_STARTED', { questionIndex: 0 }, QUESTION_WAIT);
      s.send('ANSWER_SUBMIT', { questionIndex: 0, choiceIndex: 0 });
    }
    const ended = await teacher.waitFor('QUESTION_ENDED', { questionIndex: 0 }, 4000);
    expect(myResult(teacher, 0)).toBeNull();
    expect(ended.payload.ranking as Ranked[]).toHaveLength(2);

    for (const s of students) s.send('ROOM_LEAVE', { roomId: room.roomId });
    expect((await teacher.waitFor('ROOM_CLOSED')).payload).toEqual({ reason: 'EMPTY' });
    expect((await roomRow(room.roomId))?.status).toBe('EXPIRED');
  }, 60_000);

  it('시작할 때 보기를 만들 수 없으면 카운트다운을 취소하고 대기실로 돌아간다', async () => {
    const hostUser = await makeUser();
    const packId = await createPack(hostUser);
    const room = (await call(hostUser, 'POST', '/battles/rooms', settings(packId))).json() as Room;
    const guestUser = await makeUser();
    await call(guestUser, 'POST', `/battles/rooms/${room.inviteCode}/join`);
    const [host] = (await subscribeAll(room.roomId, [hostUser, guestUser])) as [WsClient];
    await db.update(words).set({ deletedAt: new Date() }).where(eq(words.packId, packId));

    host.send('ROOM_START', { roomId: room.roomId });
    expect((await host.waitFor('COUNTDOWN_CANCELLED', {}, QUESTION_WAIT)).payload).toEqual({
      reason: 'QUESTIONS_UNAVAILABLE',
    });
    expect((await roomRow(room.roomId))?.status).toBe('WAITING');
    expect(await db.select().from(battles).where(eq(battles.roomId, room.roomId))).toEqual([]);
  });
});
