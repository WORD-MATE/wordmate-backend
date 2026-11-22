import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { auditLogs, faqs, type NewUser, users } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { createTestApp, inject } from './support/create-test-app.js';

type Faq = { faqId: string; category: string; question: string; answer: string };

describe('FAQ', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let admin: AuthUser;
  const userIds: string[] = [];
  const faqIds: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `FAQ${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 1 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (
    user: AuthUser,
    method: 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const publicList = async (query = '') =>
    (await inject(app, { method: 'GET', url: `/faqs${query}` })).json() as Faq[];

  const create = async (body: object) => {
    const res = await call(admin, 'POST', '/admin/faqs', body);
    expect(res.statusCode).toBe(201);
    const { faqId } = res.json();
    faqIds.push(faqId);
    return faqId as string;
  };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    admin = await makeUser({ role: 'TEACHER', isAdmin: true });
  });

  afterAll(async () => {
    if (faqIds.length > 0) await db.delete(faqs).where(inArray(faqs.id, faqIds));
    await db.delete(auditLogs).where(inArray(auditLogs.actorId, userIds));
    await app.close();
  });

  it('로그인 없이 분류별로 순서대로 보여 주고, 순서를 비우면 맨 뒤에 붙는다', async () => {
    const first = await create({
      category: 'STUDY',
      question: '복습은 언제?',
      answer: '매일',
      order: 10,
    });
    const second = await create({ category: 'STUDY', question: '오답노트는?', answer: '자동' });
    const top = await create({ category: 'STUDY', question: '맨 앞', answer: '먼저', order: 0 });

    const study = await publicList('?category=STUDY');
    const ours = study.filter((f) => faqIds.includes(f.faqId)).map((f) => f.faqId);
    expect(ours).toEqual([top, first, second]);
    expect(study.find((f) => f.faqId === first)).toEqual({
      faqId: first,
      category: 'STUDY',
      question: '복습은 언제?',
      answer: '매일',
      order: 10,
    });
  });

  it('수정·삭제와 없는 FAQ', async () => {
    const faqId = await create({ category: 'ACCOUNT', question: '탈퇴는?', answer: '설정에서' });
    expect(
      (
        await call(admin, 'PATCH', `/admin/faqs/${faqId}`, {
          category: 'OTHER',
          answer: '고객센터',
        })
      ).statusCode,
    ).toBe(204);
    expect((await publicList('?category=OTHER')).find((f) => f.faqId === faqId)).toMatchObject({
      question: '탈퇴는?',
      answer: '고객센터',
    });
    expect((await call(admin, 'PATCH', `/admin/faqs/${faqId}`, {})).statusCode).toBe(400);

    expect((await call(admin, 'DELETE', `/admin/faqs/${faqId}`)).statusCode).toBe(204);
    expect((await publicList()).some((f) => f.faqId === faqId)).toBe(false);
    expect((await call(admin, 'DELETE', `/admin/faqs/${faqId}`)).json().code).toBe('FAQ_NOT_FOUND');
    expect((await call(admin, 'PATCH', `/admin/faqs/${newId()}`, { answer: 'x' })).statusCode).toBe(
      404,
    );
  });

  it('관리자만 바꿀 수 있다', async () => {
    const student = await makeUser();
    expect(
      (
        await call(student, 'POST', '/admin/faqs', {
          category: 'STUDY',
          question: 'q',
          answer: 'a',
        })
      ).statusCode,
    ).toBe(403);
  });
});
