import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray, or } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { kstDate } from '../src/common/time/kst.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  battleAnswers,
  battleQuestions,
  battleResults,
  battleRoomParticipants,
  battleRooms,
  battles,
  blocks,
  classes,
  devices,
  friendships,
  inquiries,
  inquiryImages,
  type NewUser,
  notifications,
  packs,
  teacherClasses,
  users,
  withdrawnSuspensions,
  words,
  wrongNotes,
  xpLedger,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import type { DataGsmProfile } from '../src/modules/auth/datagsm/datagsm.client.js';
import { DataGsmClient } from '../src/modules/auth/datagsm/datagsm.client.js';
import { BattleFinishService } from '../src/modules/battles/battle-finish.service.js';
import { RankingService } from '../src/modules/ranking/ranking.service.js';
import { rankKey } from '../src/modules/ranking/ranking-keys.js';
import { InquiryImageStorage } from '../src/modules/support/inquiry-image.storage.js';
import { WITHDRAWN_USER_NAME } from '../src/modules/users/user-summary.js';
import { createTestApp, inject } from './support/create-test-app.js';
import { TEST_REDIRECT_URI } from './support/test-env.js';

const profileOf = (datagsmId: string): DataGsmProfile => ({
  datagsmId,
  datagsmStudentId: `st-${datagsmId}`,
  email: `${datagsmId}@gsm.hs.kr`,
  role: 'STUDENT',
  name: '탈퇴학생',
  studentNumber: '3107',
  grade: 3,
  classNo: 1,
  number: 7,
  inactive: false,
  pending: false,
});

describe('회원 탈퇴', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let valkey: Redis;
  let profile: DataGsmProfile;
  const userIds: string[] = [];
  const datagsmIds: string[] = [];

  const fakeDataGsm = {
    exchangeCode: async () => 'datagsm-access-token',
    getProfile: async () => profile,
  };

  let loginCount = 0;
  const login = () =>
    inject(app, {
      method: 'POST',
      url: '/auth/datagsm',
      remoteAddress: `10.9.0.${++loginCount}`,
      payload: { code: 'auth-code', codeVerifier: 'v'.repeat(43), redirectUri: TEST_REDIRECT_URI },
    });

  /** 새 DataGSM 계정으로 로그인해 토큰을 받는다 */
  const signUp = async () => {
    profile = profileOf(randomUUID());
    datagsmIds.push(profile.datagsmId);
    const res = await login();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    userIds.push(body.user.userId);
    return {
      userId: body.user.userId as string,
      accessToken: body.accessToken as string,
      refreshToken: body.refreshToken as string,
    };
  };

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `탈퇴${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 3 : null,
      classNo: role === 'STUDENT' ? 1 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const tokenOf = (user: AuthUser) => app.get(AccessTokenService).sign(user);

  const withdraw = (accessToken: string, payload?: object) =>
    inject(app, {
      method: 'DELETE',
      url: '/users/me',
      payload,
      headers: { authorization: `Bearer ${accessToken}` },
    });

  const userRow = async (userId: string) =>
    (await db.select().from(users).where(eq(users.id, userId)))[0];

  const insertPack = async (ownerUserId: string) => {
    const packId = newId();
    await db
      .insert(packs)
      .values({ id: packId, type: 'MINE', ownerUserId, name: `팩${packId.slice(-6)}` });
    const wordId = newId();
    await db.insert(words).values({
      id: wordId,
      packId,
      english: 'leave',
      englishNorm: 'leave',
      meanings: ['떠나다'],
    });
    return { packId, wordId };
  };

  const insertRoom = async (
    packId: string,
    status: 'WAITING' | 'FINISHED',
    hostUserId: string,
    type: 'NORMAL' | 'CLASS' = 'NORMAL',
    classId: string | null = null,
  ) => {
    const roomId = newId();
    await db.insert(battleRooms).values({
      id: roomId,
      inviteCode: randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase(),
      type,
      status,
      hostUserId,
      classId,
      packId,
      packName: '탈퇴팩',
      questionType: 'EN_TO_KO_CHOICE',
      questionCount: 10,
      timeLimitSec: 15,
      maxParticipants: 4,
      duplicateQuestions: false,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      finishedAt: status === 'FINISHED' ? new Date() : null,
    });
    return roomId;
  };

  beforeAll(async () => {
    app = await createTestApp({ overrides: [[DataGsmClient, fakeDataGsm]] });
    db = app.get(DB);
    valkey = app.get(VALKEY);
  });

  afterAll(async () => {
    await db
      .delete(withdrawnSuspensions)
      .where(inArray(withdrawnSuspensions.datagsmId, datagsmIds));
    await app.close();
  });

  it('확인 값이 없거나 false면 400 USER_WITHDRAW_NOT_CONFIRMED이고 아무것도 바꾸지 않는다', async () => {
    const user = await makeUser();
    const token = await tokenOf(user);
    for (const payload of [undefined, {}, { confirm: false }]) {
      const res = await withdraw(token, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('USER_WITHDRAW_NOT_CONFIRMED');
    }
    expect((await userRow(user.userId))?.status).toBe('ACTIVE');
  });

  it('세션·개인정보·개인 데이터를 지우고, 같은 DataGSM 계정으로 다시 로그인하면 새 계정이 된다', async () => {
    const me = await signUp();
    const other = await makeUser();
    const storage = app.get(InquiryImageStorage);

    const removable = await insertPack(me.userId);
    const played = await insertPack(me.userId);
    await db
      .update(packs)
      .set({ shareCode: randomUUID().slice(0, 12) })
      .where(eq(packs.id, played.packId));
    // 내 팩으로 한 끝난 대결: 상대의 결과 화면에는 "탈퇴한 사용자"로 남는다
    const roomId = await insertRoom(played.packId, 'FINISHED', me.userId);
    const battleId = newId();
    await db.insert(battles).values({
      id: battleId,
      roomId,
      questionCount: 10,
      timeLimitSec: 15,
      phase: 'FINISHED',
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    await db.insert(battleResults).values(
      [me.userId, other.userId].map((userId, i) => ({
        battleId,
        userId,
        rank: i + 1,
        score: 100 - i * 10,
        correctCount: 5,
        totalTimeMs: 1000,
        outcome: i === 0 ? ('WIN' as const) : ('LOSE' as const),
        xpEarned: 10,
        finishedAt: new Date(),
      })),
    );

    await db.insert(xpLedger).values({
      userId: me.userId,
      source: 'STUDY',
      refKey: `withdraw:${me.userId}`,
      amount: 30,
      date: kstDate(),
    });
    await db.update(users).set({ totalXp: 30 }).where(eq(users.id, me.userId));
    await app.get(RankingService).addXp(me.userId, 30);
    await db.insert(wrongNotes).values({
      userId: me.userId,
      wordId: removable.wordId,
      packId: removable.packId,
      questionType: 'EN_TO_KO_CHOICE',
      source: 'STUDY',
      firstWrongAt: new Date(),
      lastWrongAt: new Date(),
    });
    await db.insert(notifications).values({
      userId: me.userId,
      type: 'NOTICE',
      title: '알림',
      body: '본문',
    });
    await db.insert(friendships).values([
      { userId: me.userId, friendId: other.userId, since: new Date() },
      { userId: other.userId, friendId: me.userId, since: new Date() },
    ]);
    await db.insert(blocks).values({ blockerId: other.userId, blockedId: me.userId });
    const inquiryId = newId();
    await db.insert(inquiries).values({
      id: inquiryId,
      userId: me.userId,
      type: 'OTHER',
      title: '문의',
      content: '내용',
      platform: 'IOS',
      appVersion: '1.0.0',
    });
    const imageId = newId();
    const imageKey = storage.keyOf(imageId);
    await storage.save(imageKey, Buffer.from('image'));
    await db.insert(inquiryImages).values({
      id: imageId,
      inquiryId,
      storageKey: imageKey,
      mime: 'image/png',
      size: 5,
      sortOrder: 0,
    });

    const res = await withdraw(me.accessToken, { confirm: true });
    expect(res.statusCode).toBe(204);

    const row = await userRow(me.userId);
    expect(row).toMatchObject({
      status: 'WITHDRAWN',
      name: WITHDRAWN_USER_NAME,
      datagsmId: null,
      datagsmStudentId: null,
      email: null,
      studentNumber: null,
      grade: null,
      classNo: null,
      number: null,
      totalXp: 0,
    });
    expect(row?.withdrawnAt).toBeInstanceOf(Date);

    // 남은 액세스 토큰과 리프레시 토큰을 바로 막는다
    const after = await inject(app, {
      url: '/users/me',
      headers: { authorization: `Bearer ${me.accessToken}` },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json().code).toBe('AUTH_INVALID');
    const refreshed = await inject(app, {
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: me.refreshToken },
    });
    expect(refreshed.statusCode).toBe(401);
    expect(await db.select().from(devices).where(eq(devices.userId, me.userId))).toHaveLength(0);

    // 개인 데이터
    expect(await db.select().from(xpLedger).where(eq(xpLedger.userId, me.userId))).toHaveLength(0);
    expect(await db.select().from(wrongNotes).where(eq(wrongNotes.userId, me.userId))).toHaveLength(
      0,
    );
    expect(
      await db.select().from(notifications).where(eq(notifications.userId, me.userId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(friendships)
        .where(or(eq(friendships.userId, me.userId), eq(friendships.friendId, me.userId))),
    ).toHaveLength(0);
    expect(await db.select().from(blocks).where(eq(blocks.blockedId, me.userId))).toHaveLength(0);
    expect(await db.select().from(inquiries).where(eq(inquiries.userId, me.userId))).toHaveLength(
      0,
    );
    expect(await storage.read(imageKey)).toBeNull();

    // 랭킹에서 바로 빠진다
    const today = kstDate();
    for (const scope of ['school', 'grade:3', 'class:3-1']) {
      expect(await valkey.zscore(rankKey('WEEKLY', today, scope), me.userId)).toBeNull();
      expect(await valkey.zscore(rankKey('ALL', today, scope), me.userId)).toBeNull();
    }

    // 대결에 쓰이지 않은 팩은 지우고, 쓰인 팩은 소프트 삭제하고 공유를 끊는다
    expect(await db.select().from(packs).where(eq(packs.id, removable.packId))).toHaveLength(0);
    expect(await db.select().from(words).where(eq(words.packId, removable.packId))).toHaveLength(0);
    const [kept] = await db.select().from(packs).where(eq(packs.id, played.packId));
    expect(kept?.deletedAt).toBeInstanceOf(Date);
    expect(kept?.shareCode).toBeNull();

    // 끝난 대결 결과는 남고, 상대에게는 "탈퇴한 사용자"로 보인다
    const result = await inject(app, {
      url: `/battles/${battleId}/result`,
      headers: { authorization: `Bearer ${await tokenOf(other)}` },
    });
    expect(result.statusCode).toBe(200);
    const withdrawn = result
      .json()
      .ranking.find((entry: { user: { userId: string } }) => entry.user.userId === me.userId);
    expect(withdrawn.user).toMatchObject({ name: WITHDRAWN_USER_NAME, grade: null, classNo: null });

    // 같은 DataGSM 계정으로 다시 로그인하면 새 계정
    const again = await login();
    expect(again.statusCode).toBe(200);
    expect(again.json().user.userId).not.toBe(me.userId);
    userIds.push(again.json().user.userId);

    // 이미 탈퇴한 토큰으로 다시 호출해도 401
    const twice = await withdraw(me.accessToken, { confirm: true });
    expect(twice.statusCode).toBe(401);
  });

  it('대기 중인 대결방에서는 자동으로 나가고 방장이 넘어간다', async () => {
    const me = await signUp();
    const other = await makeUser();
    const pack = await insertPack(other.userId);
    const roomId = await insertRoom(pack.packId, 'WAITING', me.userId);
    await db.insert(battleRoomParticipants).values([
      { roomId, userId: me.userId, isHost: true, joinedAt: new Date() },
      { roomId, userId: other.userId, joinedAt: new Date(Date.now() + 1) },
    ]);

    expect((await withdraw(me.accessToken, { confirm: true })).statusCode).toBe(204);

    const [mine] = await db
      .select()
      .from(battleRoomParticipants)
      .where(
        and(
          eq(battleRoomParticipants.roomId, roomId),
          eq(battleRoomParticipants.userId, me.userId),
        ),
      );
    expect(mine).toMatchObject({ active: false, state: 'LEFT' });
    const [room] = await db.select().from(battleRooms).where(eq(battleRooms.id, roomId));
    expect(room?.hostUserId).toBe(other.userId);
  });

  it('교사는 담당 반 연결을 지우고, 진행하던 교사용 방을 닫는다', async () => {
    const teacher = await makeUser({ role: 'TEACHER' });
    const [klass] = await db.select().from(classes).limit(1);
    const classId = klass?.id as string;
    await db.insert(teacherClasses).values({ teacherId: teacher.userId, classId });
    const pack = await insertPack(teacher.userId);
    const roomId = await insertRoom(pack.packId, 'WAITING', teacher.userId, 'CLASS', classId);

    expect((await withdraw(await tokenOf(teacher), { confirm: true })).statusCode).toBe(204);

    expect(
      await db.select().from(teacherClasses).where(eq(teacherClasses.teacherId, teacher.userId)),
    ).toHaveLength(0);
    const [room] = await db.select().from(battleRooms).where(eq(battleRooms.id, roomId));
    expect(room?.status).toBe('EXPIRED');
  });

  it('정지 중에 탈퇴하면 정지 기간 동안 403 AUTH_WITHDRAWN_SUSPENDED, 끝나면 새로 가입한다', async () => {
    const me = await signUp();
    const until = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    await db
      .update(users)
      .set({ status: 'SUSPENDED', suspendedUntil: until, suspendReason: '욕설' })
      .where(eq(users.id, me.userId));

    expect((await withdraw(me.accessToken, { confirm: true })).statusCode).toBe(204);
    const [kept] = await db
      .select()
      .from(withdrawnSuspensions)
      .where(eq(withdrawnSuspensions.datagsmId, profile.datagsmId));
    expect(kept).toMatchObject({ suspendedUntil: until, reason: '욕설' });

    const blocked = await login();
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({
      code: 'AUTH_WITHDRAWN_SUSPENDED',
      detail: { until: until.toISOString() },
    });

    await db
      .update(withdrawnSuspensions)
      .set({ suspendedUntil: new Date(Date.now() - 1000) })
      .where(eq(withdrawnSuspensions.datagsmId, profile.datagsmId));
    const allowed = await login();
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().user.userId).not.toBe(me.userId);
    userIds.push(allowed.json().user.userId);
  });

  it('활동 중인 마지막 관리자는 409 USER_LAST_ADMIN, 다른 관리자가 있으면 탈퇴하고 권한도 사라진다', async () => {
    const admin = await makeUser({ role: 'TEACHER', isAdmin: true });
    const others = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isAdmin, true), eq(users.status, 'ACTIVE')));
    const otherIds = others.map((row) => row.id).filter((id) => id !== admin.userId);
    const token = await tokenOf(admin);
    try {
      if (otherIds.length > 0) {
        await db.update(users).set({ isAdmin: false }).where(inArray(users.id, otherIds));
      }
      const res = await withdraw(token, { confirm: true });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('USER_LAST_ADMIN');
      expect((await userRow(admin.userId))?.status).toBe('ACTIVE');
      // 실패하면 먼저 걸어 둔 토큰 차단을 되돌린다
      expect(await valkey.exists(`auth:blocked:${admin.userId}`)).toBe(0);
    } finally {
      if (otherIds.length > 0) {
        await db.update(users).set({ isAdmin: true }).where(inArray(users.id, otherIds));
      }
    }

    const next = await makeUser({ role: 'TEACHER', isAdmin: true });
    try {
      expect((await withdraw(token, { confirm: true })).statusCode).toBe(204);
      expect(await userRow(admin.userId)).toMatchObject({ status: 'WITHDRAWN', isAdmin: false });
    } finally {
      await db.update(users).set({ isAdmin: false }).where(eq(users.id, next.userId));
    }
  });

  it('대결 중에 탈퇴한 사람은 대결이 끝나도 결과 행만 남고 XP·오답노트가 다시 생기지 않는다', async () => {
    const me = await signUp();
    const other = await makeUser();
    const pack = await insertPack(other.userId);
    const roomId = await insertRoom(pack.packId, 'FINISHED', other.userId);
    const startedAt = new Date(Date.now() - 60 * 1000);
    const battleId = newId();
    await db.insert(battles).values({
      id: battleId,
      roomId,
      questionCount: 1,
      timeLimitSec: 15,
      phase: 'QUESTION',
      startedAt,
    });
    await db.insert(battleQuestions).values({
      battleId,
      idx: 0,
      wordId: pack.wordId,
      questionType: 'EN_TO_KO_CHOICE',
      prompt: 'leave',
      choices: ['떠나다', '오다', '가다', '보다'],
      answerIndex: 0,
    });
    await db.insert(battleRoomParticipants).values([
      { roomId, userId: other.userId, isHost: true, joinedAt: startedAt },
      { roomId, userId: me.userId, joinedAt: startedAt },
    ]);
    await db.insert(battleAnswers).values(
      [me.userId, other.userId].map((userId) => ({
        battleId,
        idx: 0,
        userId,
        choiceIndex: 1,
        elapsedMs: 1000,
        correct: false,
        score: 0,
      })),
    );
    // 나가기 처리 전에 대결이 끝나는 경우: 아직 방에 남아 있는 상태로 끝난다
    expect((await withdraw(me.accessToken, { confirm: true })).statusCode).toBe(204);
    await db
      .update(battleRoomParticipants)
      .set({ active: true, state: 'CONNECTED', leftAt: null })
      .where(
        and(
          eq(battleRoomParticipants.roomId, roomId),
          eq(battleRoomParticipants.userId, me.userId),
        ),
      );

    const [room] = await db.select().from(battleRooms).where(eq(battleRooms.id, roomId));
    const [battle] = await db.select().from(battles).where(eq(battles.id, battleId));
    const finish = app.get(BattleFinishService);
    await db.transaction((tx) =>
      finish.finalize(
        tx,
        room as typeof battleRooms.$inferSelect,
        battle as typeof battles.$inferSelect,
        new Date(),
      ),
    );

    expect(
      await db
        .select()
        .from(battleResults)
        .where(and(eq(battleResults.battleId, battleId), eq(battleResults.userId, me.userId))),
    ).toHaveLength(1);
    expect(await db.select().from(wrongNotes).where(eq(wrongNotes.userId, me.userId))).toHaveLength(
      0,
    );
    expect(await db.select().from(xpLedger).where(eq(xpLedger.userId, me.userId))).toHaveLength(0);
    expect(
      await db.select().from(wrongNotes).where(eq(wrongNotes.userId, other.userId)),
    ).toHaveLength(1);
    await db
      .update(battleRoomParticipants)
      .set({ active: false })
      .where(eq(battleRoomParticipants.roomId, roomId));
  });
});
