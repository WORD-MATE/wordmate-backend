import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  type NewUser,
  packs,
  practiceSessions,
  users,
  words,
  wrongNotes,
  xpLedger,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { MaintenanceService } from '../src/modules/maintenance/maintenance.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

type Question = { index: number; prompt: string; choices: string[]; answerIndex: number };

describe('연습 모드', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `연습${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 2 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (user: AuthUser, url: string, payload?: object) =>
    inject(app, {
      method: 'POST',
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const createPack = async (user: AuthUser, count = 10) => {
    const packId = (await call(user, '/packs', { name: `연습팩 ${newId().slice(-6)}` })).json()
      .packId as string;
    await call(user, `/packs/${packId}/words`, {
      words: Array.from({ length: count }, (_, i) => ({
        english: `practice${i}`,
        meanings: [`연습${i}`],
      })),
    });
    return packId;
  };

  const settings = (packId: string) => ({
    packId,
    questionType: 'EN_TO_KO_CHOICE',
    questionCount: 10,
    timeLimitSec: 10,
  });

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
  });

  afterAll(async () => {
    await db.delete(practiceSessions).where(inArray(practiceSessions.userId, userIds));
    await db.delete(wrongNotes).where(inArray(wrongNotes.userId, userIds));
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

  it('시작하면 문항과 정답을 내려주고, 단어가 모자라면 400, 교사는 403', async () => {
    const student = await makeUser();
    const res = await call(student, '/practice/sessions', settings(await createPack(student)));
    expect(res.statusCode).toBe(201);
    const body = res.json() as { practiceId: string; questions: Question[] };
    expect(body.questions).toHaveLength(10);
    expect(body.questions.map((q) => q.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const q of body.questions) {
      expect(q.choices).toHaveLength(4);
      expect(q.prompt).toMatch(/^practice\d$/);
      // 정답 보기는 문제 단어의 뜻 (practiceN → 연습N)
      expect(q.choices[q.answerIndex]).toBe(q.prompt.replace('practice', '연습'));
    }

    const small = await createPack(student, 5);
    expect((await call(student, '/practice/sessions', settings(small))).json().code).toBe(
      'BATTLE_PACK_TOO_FEW_WORDS',
    );
    const teacher = await makeUser({ role: 'TEACHER', isAdmin: true });
    expect(
      (await call(teacher, '/practice/sessions', settings(await createPack(student)))).statusCode,
    ).toBe(403);
  });

  it('끝내면 대결과 같은 점수, 틀린 단어는 오답노트, 다시 끝내면 409', async () => {
    const student = await makeUser();
    const before = (await db.select().from(users).where(eq(users.id, student.userId)))[0];
    const { practiceId, questions } = (
      await call(student, '/practice/sessions', settings(await createPack(student)))
    ).json() as { practiceId: string; questions: Question[] };
    const at = (i: number) => questions[i] as Question;
    const answers = [
      // 5개 정답 (1초 → 100 + 45)
      ...[0, 1, 2, 3, 4].map((i) => ({
        index: i,
        choiceIndex: at(i).answerIndex,
        elapsedMs: 1000,
      })),
      // 오답 3개
      ...[5, 6, 7].map((i) => ({
        index: i,
        choiceIndex: (at(i).answerIndex + 1) % 4,
        elapsedMs: 2000,
      })),
      // 제한 시간을 넘긴 정답은 미응답, 9번은 보내지 않음
      { index: 8, choiceIndex: at(8).answerIndex, elapsedMs: 10_001 },
    ];

    expect(
      (
        await call(student, `/practice/sessions/${practiceId}/complete`, {
          answers: [...answers, { index: 10, choiceIndex: 0, elapsedMs: 0 }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call(student, `/practice/sessions/${practiceId}/complete`, {
          answers: [answers[0], answers[0]],
        })
      ).statusCode,
    ).toBe(400);
    const other = await makeUser();
    expect(
      (await call(other, `/practice/sessions/${practiceId}/complete`, { answers })).json().code,
    ).toBe('BATTLE_PRACTICE_NOT_FOUND');

    const res = await call(student, `/practice/sessions/${practiceId}/complete`, { answers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ score: 5 * 145, correctCount: 5, total: 10 });
    expect(
      (await call(student, `/practice/sessions/${practiceId}/complete`, { answers })).json().code,
    ).toBe('BATTLE_PRACTICE_ALREADY_COMPLETED');

    const notes = await db.select().from(wrongNotes).where(eq(wrongNotes.userId, student.userId));
    expect(notes).toHaveLength(5);
    expect(notes.every((n) => n.source === 'BATTLE' && n.questionType === 'EN_TO_KO_CHOICE')).toBe(
      true,
    );
    // XP는 주지 않는다
    const after = (await db.select().from(users).where(eq(users.id, student.userId)))[0];
    expect(after?.totalXp).toBe(before?.totalXp);
    expect(await db.select().from(xpLedger).where(eq(xpLedger.userId, student.userId))).toEqual([]);
    expect(
      (await call(student, `/practice/sessions/${newId()}/complete`, { answers })).json().code,
    ).toBe('BATTLE_PRACTICE_NOT_FOUND');
  });

  it('7일 지난 연습은 정리 작업이 지운다', async () => {
    const student = await makeUser();
    const packId = await createPack(student);
    const old = (await call(student, '/practice/sessions', settings(packId))).json().practiceId;
    const recent = (await call(student, '/practice/sessions', settings(packId))).json().practiceId;
    await db
      .update(practiceSessions)
      .set({ createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(practiceSessions.id, old));
    expect(await app.get(MaintenanceService).purgePracticeSessions()).toBeGreaterThanOrEqual(1);
    const left = await db
      .select({ id: practiceSessions.id })
      .from(practiceSessions)
      .where(inArray(practiceSessions.id, [old, recent]));
    expect(left).toEqual([{ id: recent }]);
  });
});
