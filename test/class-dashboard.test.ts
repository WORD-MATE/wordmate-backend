import { randomInt, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import type { QuestionType } from '../src/common/enums.js';
import { kstDate, kstMonthRange, kstWeekRange } from '../src/common/time/kst.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  battleResults,
  battleRooms,
  battles,
  classes,
  dailyStudiedWords,
  dailyStudyStats,
  type NewUser,
  packs,
  studyRecords,
  teacherClasses,
  userStreaks,
  users,
  words,
  wrongNotes,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { createTestApp, inject } from './support/create-test-app.js';

// 다른 테스트의 반과 겹치지 않게 실제로 없는 학년의 임의 반을 쓴다
const GRADE = 7;

describe('교사 반 학생 목록·대시보드', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];
  const classIds: string[] = [];
  const packIds: string[] = [];
  const roomIds: string[] = [];

  let classId: string;
  let otherClassId: string;
  let teacher: AuthUser;
  let otherTeacher: AuthUser;
  let studentAdmin: AuthUser;
  let first: AuthUser;
  let second: AuthUser;
  let suspended: AuthUser;
  let wordA: string;
  let wordB: string;

  const today = kstDate();
  const week = kstWeekRange(today);
  const month = kstMonthRange(today);
  // 이번 주·이번 달 어느 쪽에도 들지 않는 시각
  const before = new Date(Math.min(week.start.getTime(), month.start.getTime()) - 86_400_000);
  const beforeDate = kstDate(before);

  const makeClass = async (classNo: number) => {
    const id = newId();
    classIds.push(id);
    await db.insert(classes).values({ id, grade: GRADE, classNo });
    return id;
  };

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db
      .insert(users)
      .values({ id: userId, name: `반${userId.slice(-4)}`, role, ...overrides });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (user: AuthUser, url: string) =>
    inject(app, {
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const insertBattle = async (
    packId: string,
    finishedAt: Date,
    results: [AuthUser, 'WIN' | 'LOSE'][],
  ) => {
    const roomId = newId();
    roomIds.push(roomId);
    await db.insert(battleRooms).values({
      id: roomId,
      inviteCode: randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase(),
      type: 'NORMAL',
      status: 'FINISHED',
      packId,
      packName: '반팩',
      questionType: 'EN_TO_KO_CHOICE',
      questionCount: 10,
      timeLimitSec: 15,
      maxParticipants: 4,
      duplicateQuestions: false,
      expiresAt: finishedAt,
      finishedAt,
    });
    const battleId = newId();
    await db.insert(battles).values({
      id: battleId,
      roomId,
      questionCount: 10,
      timeLimitSec: 15,
      phase: 'FINISHED',
      startedAt: finishedAt,
      finishedAt,
    });
    await db.insert(battleResults).values(
      results.map(([user, outcome], i) => ({
        battleId,
        userId: user.userId,
        rank: i + 1,
        score: 100 - i * 10,
        correctCount: 5,
        totalTimeMs: 1000,
        outcome,
        xpEarned: 0,
        finishedAt,
      })),
    );
  };

  const wrong = (
    user: AuthUser,
    wordId: string,
    packId: string,
    at: Date,
    questionType: QuestionType = 'EN_TO_KO_CHOICE',
  ) => ({
    userId: user.userId,
    wordId,
    packId,
    questionType,
    source: 'STUDY' as const,
    firstWrongAt: at,
    lastWrongAt: at,
  });

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);

    const classNo = randomInt(20, 120);
    classId = await makeClass(classNo);
    otherClassId = await makeClass(classNo + 1);
    const member = (number: number, overrides: Partial<NewUser> = {}) =>
      makeUser({
        grade: GRADE,
        classNo,
        number,
        studentNumber: `${GRADE}${classNo}${String(number).padStart(2, '0')}`,
        ...overrides,
      });

    teacher = await makeUser({ role: 'TEACHER' });
    otherTeacher = await makeUser({ role: 'TEACHER' });
    studentAdmin = await makeUser({ isAdmin: true });
    await db.insert(teacherClasses).values([
      { teacherId: teacher.userId, classId },
      { teacherId: otherTeacher.userId, classId: otherClassId },
    ]);

    second = await member(2);
    first = await member(1);
    suspended = await member(3, { status: 'SUSPENDED' });
    const inactive = await member(4, { status: 'INACTIVE' });
    await member(5, { status: 'WITHDRAWN' });

    const packId = newId();
    packIds.push(packId);
    await db
      .insert(packs)
      .values({ id: packId, type: 'MINE', ownerUserId: teacher.userId, name: '반팩' });
    const wordC = newId();
    wordA = newId();
    wordB = newId();
    const wordIds = [wordA, wordB, wordC];
    await db.insert(words).values(
      ['alpha', 'bravo', 'charlie'].map((english, i) => ({
        id: wordIds[i],
        packId,
        english,
        englishNorm: english,
        meanings: [`뜻${i}`],
      })),
    );
    const now = new Date();

    await db.insert(dailyStudyStats).values([
      { userId: first.userId, date: today, solvedCount: 10, gradedCount: 8, correctCount: 6 },
      { userId: first.userId, date: beforeDate, solvedCount: 5, gradedCount: 5, correctCount: 5 },
      { userId: second.userId, date: today, solvedCount: 4, gradedCount: 4, correctCount: 4 },
      { userId: inactive.userId, date: today, solvedCount: 4, gradedCount: 4, correctCount: 0 },
    ]);
    await db.insert(dailyStudiedWords).values([
      { userId: first.userId, date: today, wordId: wordA },
      { userId: first.userId, date: today, wordId: wordB },
      { userId: first.userId, date: beforeDate, wordId: wordC },
    ]);
    await db.insert(userStreaks).values([
      { userId: first.userId, kind: 'STUDY', current: 3, best: 3, lastDate: today },
      { userId: second.userId, kind: 'STUDY', current: 5, best: 5, lastDate: beforeDate },
    ]);
    await db.insert(studyRecords).values({
      userId: first.userId,
      source: 'PACK',
      packId,
      mode: 'CHOICE',
      direction: 'EN_TO_KO',
      reason: 'FINISHED',
      correctCount: 6,
      wrongCount: 2,
      accuracy: 75,
      xpEarned: 0,
      packCompleteBonus: false,
      completedAt: now,
      completedDate: today,
    });

    await insertBattle(packId, now, [
      [first, 'WIN'],
      [second, 'LOSE'],
    ]);
    await insertBattle(packId, before, [[first, 'WIN']]);

    await db
      .insert(wrongNotes)
      .values([
        wrong(first, wordA, packId, now),
        wrong(first, wordA, packId, now, 'KO_TO_EN_CHOICE'),
        wrong(second, wordA, packId, now),
        wrong(second, wordB, packId, now),
        wrong(first, wordC, packId, before),
        wrong(inactive, wordB, packId, now),
      ]);
  });

  afterAll(async () => {
    // 방을 지우면 대결·결과가, 단어를 지우면 오답노트가 함께 지워진다
    if (roomIds.length > 0) await db.delete(battleRooms).where(inArray(battleRooms.id, roomIds));
    await db.delete(words).where(inArray(words.packId, packIds));
    await db.delete(packs).where(inArray(packs.id, packIds));
    await db.delete(classes).where(inArray(classes.id, classIds));
    await db.delete(users).where(inArray(users.id, userIds));
    await app.close();
  });

  it('학생 목록은 번호순, 휴면·탈퇴 학생은 빼고 개인정보 없이 마지막 학습 시각을 준다', async () => {
    const res = await call(teacher, `/classes/${classId}/students`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.map((s: { user: { userId: string } }) => s.user.userId)).toEqual([
      first.userId,
      second.userId,
      suspended.userId,
    ]);
    expect(body[0]).toEqual({
      user: expect.objectContaining({ userId: first.userId, grade: GRADE }),
      studentNumber: expect.any(String),
      number: 1,
      lastStudiedAt: expect.any(String),
    });
    expect(body[0].user).not.toHaveProperty('email');
    expect(body[1].lastStudiedAt).toBeNull();
  });

  it('대시보드는 이번 주 학습·대결·오답만 모은다', async () => {
    const res = await call(teacher, `/classes/${classId}/dashboard?period=WEEK`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      class: { classId, grade: GRADE },
      period: 'WEEK',
      from: kstDate(week.start),
      to: today,
      summary: { studentCount: 3, participationRate: 66.7, avgAccuracy: 87.5 },
    });
    expect(body.students).toEqual([
      expect.objectContaining({
        user: expect.objectContaining({ userId: first.userId }),
        participated: true,
        studiedWordCount: 2,
        accuracy: 75,
        streak: 3,
        battleCount: 1,
        battleWinCount: 1,
      }),
      expect.objectContaining({
        user: expect.objectContaining({ userId: second.userId }),
        participated: true,
        studiedWordCount: 0,
        accuracy: 100,
        streak: 0,
        battleCount: 1,
        battleWinCount: 0,
      }),
      expect.objectContaining({
        user: expect.objectContaining({ userId: suspended.userId }),
        participated: false,
        accuracy: null,
        battleCount: 0,
      }),
    ]);
    // 같은 학생이 여러 문제 유형으로 틀려도 한 명으로 센다
    expect(body.frequentWrongWords).toEqual([
      { wordId: wordA, english: 'alpha', meanings: ['뜻0'], wrongStudentCount: 2 },
      { wordId: wordB, english: 'bravo', meanings: ['뜻1'], wrongStudentCount: 1 },
    ]);

    const monthly = (await call(teacher, `/classes/${classId}/dashboard?period=MONTH`)).json();
    expect(monthly).toMatchObject({ period: 'MONTH', from: kstDate(month.start) });
  });

  it('관리자는 학생이어도 모든 반을 보고, 다른 교사는 403 CLASS_NOT_ASSIGNED', async () => {
    expect((await call(studentAdmin, `/classes/${classId}/dashboard?period=WEEK`)).statusCode).toBe(
      200,
    );
    expect((await call(studentAdmin, `/classes/${otherClassId}/students`)).json()).toEqual([]);

    for (const url of [
      `/classes/${classId}/students`,
      `/classes/${classId}/dashboard?period=WEEK`,
    ]) {
      const res = await call(otherTeacher, url);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('CLASS_NOT_ASSIGNED');
    }
  });

  it('없는 반 404, 담당 반이 없는 교사 403 TEACHER_CLASS_REQUIRED, 학생 403, 기간 누락 400', async () => {
    const missing = await call(teacher, `/classes/${newId()}/students`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('CLASS_NOT_FOUND');

    const unassigned = await makeUser({ role: 'TEACHER' });
    const required = await call(unassigned, `/classes/${classId}/students`);
    expect(required.statusCode).toBe(403);
    expect(required.json().code).toBe('TEACHER_CLASS_REQUIRED');

    expect((await call(first, `/classes/${classId}/students`)).json().code).toBe('FORBIDDEN');
    const invalid = await call(teacher, `/classes/${classId}/dashboard?period=DAY`);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('VALIDATION_FAILED');
  });
});
