import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { auditLogs, morningSentences, type NewUser, users } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { createTestApp, inject } from './support/create-test-app.js';

// 다른 테스트의 "오늘" 문장과 겹치지 않는 날짜
const FUTURE = '2098-05-01';
const PAST = '2001-01-01';

describe('관리자 오늘의 문장', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let admin: AuthUser;
  const userIds: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `문장관리${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 1 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (
    user: AuthUser,
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: object,
  ) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const base = (date: string) => ({
    date,
    sentence: 'Persistence is the key.',
    translation: '꾸준함이 열쇠다.',
    keywords: [{ english: 'key', meanings: ['열쇠'] }],
  });
  const blank = (answer: string) => ({
    type: 'FILL_BLANK',
    question: '_____ is the key.',
    answers: [answer],
  });

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    admin = await makeUser({ role: 'TEACHER', isAdmin: true });
  });

  afterAll(async () => {
    await db.delete(morningSentences).where(inArray(morningSentences.publishDate, [FUTURE, PAST]));
    await db.delete(auditLogs).where(inArray(auditLogs.actorId, userIds));
    await app.close();
  });

  it('본문을 분석해 미리 보여 준다', async () => {
    const res = await call(admin, 'POST', '/admin/morning/parse', {
      text: '문장: Persistence is the key.\n뜻: 꾸준함이 열쇠다.\n어휘: key | 열쇠\n퀴즈 빈칸: _____ is the key. | Persistence',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      sentence: 'Persistence is the key.',
      keywords: [{ english: 'key', meanings: ['열쇠'] }],
      quizzes: [{ type: 'FILL_BLANK', answers: ['Persistence'] }],
      warnings: [],
    });
  });

  it('검수 대기로 등록하고, 완성돼야 게시 예약된다', async () => {
    const created = await call(admin, 'POST', '/admin/morning', base(FUTURE));
    expect(created.statusCode).toBe(201);
    const { morningId, status } = created.json();
    expect(status).toBe('PENDING_REVIEW');
    expect((await call(admin, 'POST', '/admin/morning', base(FUTURE))).json().code).toBe(
      'MORNING_DATE_EXISTS',
    );

    const incomplete = await call(admin, 'POST', `/admin/morning/${morningId}/publish`);
    expect(incomplete.statusCode).toBe(400);
    expect(incomplete.json().code).toBe('MORNING_INCOMPLETE');

    expect(
      (await call(admin, 'PATCH', `/admin/morning/${morningId}`, { quizzes: [blank('nowhere')] }))
        .statusCode,
    ).toBe(204);
    expect((await call(admin, 'POST', `/admin/morning/${morningId}/publish`)).json().code).toBe(
      'MORNING_BLANK_NOT_IN_SENTENCE',
    );

    await call(admin, 'PATCH', `/admin/morning/${morningId}`, { quizzes: [blank('Persistence')] });
    expect((await call(admin, 'POST', `/admin/morning/${morningId}/publish`)).statusCode).toBe(204);
    const detail = (await call(admin, 'GET', `/admin/morning/${morningId}`)).json();
    expect(detail).toMatchObject({
      status: 'SCHEDULED',
      date: FUTURE,
      keywords: [{ english: 'key', highlight: { start: 19, end: 22 } }],
      updatedBy: expect.any(String),
    });

    // 예약된 문장은 게시할 수 있는 상태를 유지해야 한다
    expect(
      (await call(admin, 'PATCH', `/admin/morning/${morningId}`, { quizzes: [blank('x')] }))
        .statusCode,
    ).toBe(400);
    // 게시 전이면 교체할 수 있고, 교체하면 다시 검수 대기
    const replaced = await call(admin, 'POST', '/admin/morning', {
      ...base(FUTURE),
      replace: true,
    });
    expect(replaced.json()).toEqual({ morningId, status: 'PENDING_REVIEW' });

    const list = (await call(admin, 'GET', '/admin/morning?status=PENDING_REVIEW&size=50')).json();
    expect(list.items.some((i: { morningId: string }) => i.morningId === morningId)).toBe(true);
  });

  it('지난 날짜는 바로 게시되고, 게시를 취소하면 앱에서 사라진다', async () => {
    const student = await makeUser();
    const { morningId } = (
      await call(admin, 'POST', '/admin/morning', {
        ...base(PAST),
        quizzes: [blank('Persistence')],
      })
    ).json();
    expect((await call(student, 'GET', `/morning/${PAST}`)).statusCode).toBe(404);
    await call(admin, 'POST', `/admin/morning/${morningId}/publish`);
    expect((await call(student, 'GET', `/morning/${PAST}`)).json()).toMatchObject({
      date: PAST,
      sentence: 'Persistence is the key.',
    });

    expect(
      (await call(admin, 'PATCH', `/admin/morning/${morningId}`, { date: '2001-01-02' })).json()
        .code,
    ).toBe('MORNING_ALREADY_PUBLISHED');
    expect(
      (await call(admin, 'POST', '/admin/morning', { ...base(PAST), replace: true })).json().code,
    ).toBe('MORNING_ALREADY_PUBLISHED');

    expect((await call(admin, 'POST', `/admin/morning/${morningId}/unpublish`)).statusCode).toBe(
      204,
    );
    expect((await call(student, 'GET', `/morning/${PAST}`)).statusCode).toBe(404);
  });

  it('관리자만 쓸 수 있다', async () => {
    const student = await makeUser();
    expect((await call(student, 'GET', '/admin/morning')).statusCode).toBe(403);
  });
});
