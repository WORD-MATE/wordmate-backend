import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { kstDate } from '../src/common/time/kst.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  battleDailyPairs,
  battleQuestions,
  battleResults,
  battleRoomParticipants,
  battleRooms,
  battles,
  classes,
  missions,
  type NewUser,
  notifications,
  packs,
  teacherClasses,
  userMissions,
  users,
  words,
  wrongNotes,
  xpLedger,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { PlayService } from '../src/modules/battles/play.service.js';
import { createTestApp, inject } from './support/create-test-app.js';
import { connectAs, type WsClient } from './support/ws-client.js';

type Room = { roomId: string; inviteCode: string };
type Answer = 'correct' | 'wrong' | 'skip' | 'leave';

describe('대결 결과·XP·기록·다시 하기', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let play: PlayService;
  const userIds: string[] = [];
  const clients: WsClient[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `결과${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 3 : null,
      classNo: role === 'STUDENT' ? 3 : null,
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
      await call(user, 'POST', '/packs', { name: `결과팩 ${newId().slice(-6)}` })
    ).json().packId as string;
    await call(user, 'POST', `/packs/${packId}/words`, {
      words: Array.from({ length: 10 }, (_, i) => ({
        english: `result${i}`,
        meanings: [`결과${i}`],
      })),
    });
    return packId;
  };

  const settings = (packId: string) => ({
    packId,
    questionType: 'KO_TO_EN_CHOICE',
    questionCount: 10,
    timeLimitSec: 15,
    maxParticipants: 4,
  });

  /** 방을 만들고(교사면 반 방) 학생들이 참가·구독한 뒤 시작해 첫 문항까지 기다린다 */
  const startBattle = async (host: AuthUser, students: AuthUser[], classId?: string) => {
    const packId = await createPack(host);
    const room = (
      classId
        ? await call(host, 'POST', `/classes/${classId}/rooms`, settings(packId))
        : await call(host, 'POST', '/battles/rooms', settings(packId))
    ).json() as Room;
    const joiners = classId ? students : students.filter((s) => s.userId !== host.userId);
    for (const s of joiners) {
      expect((await call(s, 'POST', `/battles/rooms/${room.inviteCode}/join`)).statusCode).toBe(
        200,
      );
    }
    const everyone = classId ? [host, ...students] : students;
    const connected = await Promise.all(everyone.map((u) => connectAs(app, u)));
    clients.push(...connected);
    for (const c of connected) {
      c.send('ROOM_SUBSCRIBE', { roomId: room.roomId });
      await c.waitFor('ROOM_STATE');
    }
    const hostClient = connected.find((c) => c.user.userId === host.userId) as WsClient;
    hostClient.send('ROOM_START', { roomId: room.roomId });
    await hostClient.waitFor('QUESTION_STARTED', { questionIndex: 0 }, 9000);
    const [battle] = await db.select().from(battles).where(eq(battles.roomId, room.roomId));
    const byUser = new Map(connected.map((c) => [c.user.userId, c]));
    return { room, battleId: battle?.id as string, byUser, hostClient };
  };

  /**
   * 학생마다 문항별로 정답·오답·미응답·나가기를 정해 끝까지 진행한다.
   * 타이머를 기다리지 않도록 답을 받은 뒤 문항 종료·다음 문항을 직접 부른다 (같은 작업이 나중에 돌아도 무시된다)
   */
  const playThrough = async (
    roomId: string,
    battleId: string,
    byUser: Map<string, WsClient>,
    plan: (userId: string, idx: number) => Answer,
  ) => {
    const gone = new Set<string>();
    for (let idx = 0; idx < 10; idx++) {
      const [question] = await db
        .select({ answerIndex: battleQuestions.answerIndex })
        .from(battleQuestions)
        .where(and(eq(battleQuestions.battleId, battleId), eq(battleQuestions.idx, idx)));
      const answerIndex = question?.answerIndex as number;
      for (const [userId, client] of byUser) {
        if (gone.has(userId)) continue;
        const action = plan(userId, idx);
        if (action === 'leave') {
          client.send('ROOM_LEAVE', { roomId });
          gone.add(userId);
          await expect.poll(async () => (await participant(roomId, userId))?.state).toBe('LEFT');
        } else if (action !== 'skip') {
          const choiceIndex = action === 'correct' ? answerIndex : (answerIndex + 1) % 4;
          client.send('ANSWER_SUBMIT', { questionIndex: idx, choiceIndex });
          await client.waitFor('ANSWER_ACCEPTED', { questionIndex: idx });
        }
      }
      await play.endQuestion(battleId, idx);
      await play.startQuestion(battleId, idx + 1);
    }
    await expect
      .poll(async () => (await db.select().from(battles).where(eq(battles.id, battleId)))[0]?.phase)
      .toBe('FINISHED');
  };

  const participant = async (roomId: string, userId: string) =>
    (
      await db
        .select()
        .from(battleRoomParticipants)
        .where(
          and(eq(battleRoomParticipants.roomId, roomId), eq(battleRoomParticipants.userId, userId)),
        )
    )[0];

  const resultOf = async (battleId: string, userId: string) =>
    (
      await db
        .select()
        .from(battleResults)
        .where(and(eq(battleResults.battleId, battleId), eq(battleResults.userId, userId)))
    )[0];

  const leaveAll = async () => {
    for (const client of clients) client.socket.terminate();
    clients.length = 0;
  };

  const missionProgress = async (userId: string) =>
    Object.fromEntries(
      (
        await db
          .select({ code: missions.code, progress: userMissions.progress })
          .from(userMissions)
          .innerJoin(missions, eq(missions.id, userMissions.missionId))
          .where(eq(userMissions.userId, userId))
      ).map((row) => [row.code, row.progress]),
    );

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    play = app.get(PlayService);
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await leaveAll();
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
    await db.delete(battleDailyPairs).where(inArray(battleDailyPairs.userId, userIds));
    await db.delete(wrongNotes).where(inArray(wrongNotes.userId, userIds));
    await db.delete(xpLedger).where(inArray(xpLedger.userId, userIds));
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
    // 다른 랭킹 테스트에 섞이지 않게 랭킹에서 뺀다
    const valkey = app.get<Redis>(VALKEY);
    const keys = await valkey.keys('rank:*');
    for (const key of keys) await valkey.zrem(key, ...userIds);
    await app.close();
  });

  it('순위·결과·XP·오답노트를 확정하고, 결과 조회는 참가자와 진행자만', async () => {
    const [a, b, c] = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const { room, battleId, byUser } = await startBattle(a as AuthUser, [
      a as AuthUser,
      b as AuthUser,
      c as AuthUser,
    ]);
    const before = (
      await db
        .select()
        .from(users)
        .where(eq(users.id, a?.userId as string))
    )[0];

    // 진행 중에는 결과가 없다
    expect((await call(a as AuthUser, 'GET', `/battles/${battleId}/result`)).json().code).toBe(
      'BATTLE_NOT_FOUND',
    );
    await playThrough(room.roomId, battleId, byUser, (userId, idx) => {
      if (userId === a?.userId) return 'correct';
      if (userId === b?.userId) return idx === 9 ? 'skip' : 'wrong';
      return idx === 3 ? 'leave' : 'correct';
    });
    await (byUser.get(a?.userId as string) as WsClient).waitFor('BATTLE_FINISHED', { battleId });

    expect(await resultOf(battleId, a?.userId as string)).toMatchObject({
      rank: 1,
      correctCount: 10,
      outcome: 'WIN',
      xpEarned: 30,
      xpBlockedReason: null,
    });
    expect(await resultOf(battleId, b?.userId as string)).toMatchObject({
      rank: 2,
      score: 0,
      correctCount: 0,
      outcome: 'LOSE',
      xpEarned: 5,
    });
    const left = await resultOf(battleId, c?.userId as string);
    expect(left).toMatchObject({
      rank: null,
      correctCount: 3,
      outcome: 'LEFT',
      xpEarned: 0,
      xpBlockedReason: 'NOT_COMPLETED',
    });
    // 남은 문항은 제한 시간 전체로 센다
    expect(left?.totalTimeMs).toBeGreaterThanOrEqual(7 * 15_000);

    const after = (
      await db
        .select()
        .from(users)
        .where(eq(users.id, a?.userId as string))
    )[0];
    expect((after?.totalXp ?? 0) - (before?.totalXp ?? 0)).toBe(30);
    expect(
      await db
        .select({ refKey: xpLedger.refKey, amount: xpLedger.amount })
        .from(xpLedger)
        .where(and(eq(xpLedger.userId, a?.userId as string), eq(xpLedger.source, 'BATTLE'))),
    ).toEqual([{ refKey: `battle:${battleId}`, amount: 30 }]);
    // 미션: 완주·승리·XP (중도 이탈은 세지 않음)
    expect(await missionProgress(a?.userId as string)).toEqual({
      DAILY_BATTLE: 1,
      WEEKLY_WIN: 1,
      WEEKLY_XP: 30,
    });
    expect(await missionProgress(b?.userId as string)).toEqual({ DAILY_BATTLE: 1, WEEKLY_XP: 5 });
    expect(await missionProgress(c?.userId as string)).toEqual({});
    // 틀리거나 답하지 않은 단어는 오답노트로 (같은 단어는 한 번)
    const notes = await db
      .select()
      .from(wrongNotes)
      .where(eq(wrongNotes.userId, b?.userId as string));
    expect(notes).toHaveLength(10);
    expect(notes.every((n) => n.source === 'BATTLE' && n.questionType === 'KO_TO_EN_CHOICE')).toBe(
      true,
    );
    expect(
      await db
        .select()
        .from(wrongNotes)
        .where(eq(wrongNotes.userId, a?.userId as string)),
    ).toEqual([]);

    const res = await call(a as AuthUser, 'GET', `/battles/${battleId}/result`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      battleId,
      roomType: 'NORMAL',
      settings: { questionType: 'KO_TO_EN_CHOICE', questionCount: 10, timeLimitSec: 15 },
      me: { rank: 1, outcome: 'WIN', xp: { earned: 30, blockedReason: null } },
    });
    expect(body.me.xp.todayTotal).toBeGreaterThanOrEqual(30);
    expect(
      body.ranking.map((r: { user: { userId: string }; rank: number | null }) => [
        r.user.userId,
        r.rank,
      ]),
    ).toEqual([
      [a?.userId, 1],
      [b?.userId, 2],
      [c?.userId, null],
    ]);
    expect(body.questions).toHaveLength(10);
    expect(body.questions[0]).toMatchObject({ index: 0, correct: true });
    expect(body.questions[0].myChoiceIndex).toBe(body.questions[0].answerIndex);
    expect(typeof body.questions[0].word.english).toBe('string');

    const bResult = (await call(b as AuthUser, 'GET', `/battles/${battleId}/result`)).json();
    expect(bResult.questions[9]).toMatchObject({ myChoiceIndex: null, correct: false });
    // 중도 이탈자도 결과를 본다
    expect((await call(c as AuthUser, 'GET', `/battles/${battleId}/result`)).statusCode).toBe(200);
    const outsider = await makeUser();
    expect((await call(outsider, 'GET', `/battles/${battleId}/result`)).statusCode).toBe(403);
    expect((await call(outsider, 'GET', `/battles/${newId()}/result`)).json().code).toBe(
      'BATTLE_NOT_FOUND',
    );
    await leaveAll();
  }, 90_000);

  it('혼자 남아 완주하면 부전승(XP 없음), 같은 상대 하루 4번째와 하루 상한도 막는다', async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    const first = await startBattle(a as AuthUser, [a as AuthUser, b as AuthUser]);
    await playThrough(first.room.roomId, first.battleId, first.byUser, (userId, idx) =>
      userId === b?.userId && idx === 0 ? 'leave' : 'correct',
    );
    expect(await resultOf(first.battleId, a?.userId as string)).toMatchObject({
      rank: 1,
      outcome: 'WIN_BY_FORFEIT',
      xpEarned: 0,
      xpBlockedReason: 'FORFEIT',
    });
    await leaveAll();

    // 이미 오늘 세 번 함께 완주한 상대
    const today = kstDate();
    await db.insert(battleDailyPairs).values([
      { date: today, userId: a?.userId as string, opponentId: b?.userId as string, count: 3 },
      { date: today, userId: b?.userId as string, opponentId: a?.userId as string, count: 3 },
    ]);
    const second = await startBattle(a as AuthUser, [a as AuthUser, b as AuthUser]);
    await playThrough(second.room.roomId, second.battleId, second.byUser, (userId) =>
      userId === a?.userId ? 'correct' : 'wrong',
    );
    expect(await resultOf(second.battleId, a?.userId as string)).toMatchObject({
      outcome: 'WIN',
      xpEarned: 0,
      xpBlockedReason: 'REPEAT_LIMIT',
    });
    expect(await resultOf(second.battleId, b?.userId as string)).toMatchObject({
      outcome: 'LOSE',
      xpBlockedReason: 'REPEAT_LIMIT',
    });
    await leaveAll();

    // 하루 상한: 오늘 490을 이미 받았으면 10만
    const [c, d] = await Promise.all([makeUser(), makeUser()]);
    await db.insert(xpLedger).values({
      id: newId(),
      userId: c?.userId as string,
      source: 'STUDY',
      refKey: `test:${newId()}`,
      amount: 490,
      date: today,
    });
    const third = await startBattle(c as AuthUser, [c as AuthUser, d as AuthUser]);
    await playThrough(third.room.roomId, third.battleId, third.byUser, (userId) =>
      userId === c?.userId ? 'correct' : 'wrong',
    );
    expect(await resultOf(third.battleId, c?.userId as string)).toMatchObject({
      outcome: 'WIN',
      xpEarned: 10,
      xpBlockedReason: 'DAILY_CAP',
    });
    const me = (await call(c as AuthUser, 'GET', `/battles/${third.battleId}/result`)).json().me;
    expect(me.xp).toEqual({ earned: 10, blockedReason: 'DAILY_CAP', todayTotal: 500 });
    await leaveAll();
  }, 120_000);

  it('한 문항도 답하지 않은 완주자는 순위는 받지만 XP는 없다', async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    const { room, battleId, byUser } = await startBattle(a as AuthUser, [
      a as AuthUser,
      b as AuthUser,
    ]);
    await playThrough(room.roomId, battleId, byUser, (userId) =>
      userId === a?.userId ? 'correct' : 'skip',
    );
    expect(await resultOf(battleId, a?.userId as string)).toMatchObject({
      outcome: 'WIN',
      xpEarned: 30,
    });
    expect(await resultOf(battleId, b?.userId as string)).toMatchObject({
      rank: 2,
      outcome: 'LOSE',
      xpEarned: 0,
      xpBlockedReason: 'NOT_COMPLETED',
    });
    await leaveAll();
  }, 90_000);

  it('기록: 최신순 커서와 요약(승률·평균 정답률은 완주한 대결만)', async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    const first = await startBattle(a as AuthUser, [a as AuthUser, b as AuthUser]);
    await playThrough(first.room.roomId, first.battleId, first.byUser, (userId) =>
      userId === a?.userId ? 'correct' : 'wrong',
    );
    await leaveAll();
    const second = await startBattle(b as AuthUser, [a as AuthUser, b as AuthUser]);
    await playThrough(second.room.roomId, second.battleId, second.byUser, (userId, idx) => {
      if (userId === b?.userId) return 'correct';
      return idx < 5 ? 'correct' : idx === 5 ? 'leave' : 'skip';
    });
    await leaveAll();

    const page1 = (await call(a as AuthUser, 'GET', '/battles/history?size=1')).json();
    expect(page1.summary).toEqual({ total: 2, winRate: 1, avgAccuracy: 1 });
    expect(page1.items).toEqual([
      expect.objectContaining({
        battleId: second.battleId,
        rank: null,
        outcome: 'LEFT',
        participantCount: 2,
      }),
    ]);
    expect(page1.nextCursor).toEqual(expect.any(String));
    const page2 = (
      await call(a as AuthUser, 'GET', `/battles/history?size=1&cursor=${page1.nextCursor}`)
    ).json();
    expect(page2.items).toEqual([
      expect.objectContaining({ battleId: first.battleId, rank: 1, outcome: 'WIN' }),
    ]);
    expect(page2.nextCursor).toBeNull();

    const bHistory = (await call(b as AuthUser, 'GET', '/battles/history')).json();
    expect(bHistory.summary).toEqual({ total: 2, winRate: 0.5, avgAccuracy: 0.5 });
    const teacher = await makeUser({ role: 'TEACHER' });
    expect((await call(teacher, 'GET', '/battles/history')).statusCode).toBe(403);
  }, 90_000);

  it('다시 하기: 같은 설정의 새 방, 교사용 방은 진행한 교사만', async () => {
    const [a, b] = await Promise.all([makeUser(), makeUser()]);
    const { room, battleId, byUser } = await startBattle(a as AuthUser, [
      a as AuthUser,
      b as AuthUser,
    ]);
    await playThrough(room.roomId, battleId, byUser, () => 'correct');
    await leaveAll();

    const res = await call(b as AuthUser, 'POST', `/battles/${battleId}/rematch`);
    expect(res.statusCode).toBe(201);
    const rematch = res.json();
    expect(rematch).toMatchObject({
      type: 'NORMAL',
      status: 'WAITING',
      hostUserId: b?.userId,
      settings: { questionType: 'KO_TO_EN_CHOICE', questionCount: 10, timeLimitSec: 15 },
    });
    // a의 내 단어팩이지만 함께 한 대결이라 같은 팩으로 다시 한다
    const [original] = await db.select().from(battleRooms).where(eq(battleRooms.id, room.roomId));
    const [created] = await db.select().from(battleRooms).where(eq(battleRooms.id, rematch.roomId));
    expect(created).toMatchObject({ packId: original?.packId, sourceBattleId: battleId });
    // 대결 결과 알림은 두 사람 모두, 다시 하기 초대는 상대에게만 (새 대기실로)
    const typesOf = async (userId: string) =>
      (
        await db
          .select({ type: notifications.type, route: notifications.route })
          .from(notifications)
          .where(eq(notifications.userId, userId))
      ).filter((n) => n.type === 'BATTLE_RESULT' || n.type === 'BATTLE_INVITE');
    await expect
      .poll(() => typesOf(a?.userId as string))
      .toEqual(
        expect.arrayContaining([
          { type: 'BATTLE_RESULT', route: `/battles/${battleId}/result` },
          { type: 'BATTLE_INVITE', route: `/battles/rooms/${rematch.inviteCode}` },
        ]),
      );
    await expect
      .poll(async () => (await typesOf(b?.userId as string)).map((n) => n.type))
      .toEqual(['BATTLE_RESULT']);
    // 이미 다른 방에 있으면 409
    expect((await call(b as AuthUser, 'POST', `/battles/${battleId}/rematch`)).json().code).toBe(
      'ROOM_ALREADY_JOINED',
    );
    expect((await call(await makeUser(), 'POST', `/battles/${battleId}/rematch`)).statusCode).toBe(
      403,
    );

    const [cls] = await db.select().from(classes).limit(1);
    const teacher = await makeUser({ role: 'TEACHER' });
    await db
      .insert(teacherClasses)
      .values({ teacherId: teacher.userId, classId: cls?.id as string });
    const students = await Promise.all(
      [0, 1].map(() => makeUser({ grade: cls?.grade, classNo: cls?.classNo })),
    );
    const classBattle = await startBattle(teacher, students, cls?.id);
    const studentClients = new Map(
      [...classBattle.byUser].filter(([userId]) => userId !== teacher.userId),
    );
    await playThrough(
      classBattle.room.roomId,
      classBattle.battleId,
      studentClients,
      () => 'correct',
    );
    await leaveAll();

    expect(
      (await call(students[0] as AuthUser, 'POST', `/battles/${classBattle.battleId}/rematch`))
        .statusCode,
    ).toBe(403);
    const teacherRes = await call(teacher, 'POST', `/battles/${classBattle.battleId}/rematch`);
    expect(teacherRes.statusCode).toBe(201);
    expect(teacherRes.json()).toMatchObject({
      type: 'CLASS',
      classId: cls?.id,
      hostUserId: teacher.userId,
    });
    // 진행자도 결과를 보지만 me는 null
    const teacherView = (
      await call(teacher, 'GET', `/battles/${classBattle.battleId}/result`)
    ).json();
    expect(teacherView.me).toBeNull();
    expect(teacherView.questions[0]).toMatchObject({ myChoiceIndex: null, correct: null });
  }, 120_000);
});
