import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { auditLogs, type NewUser, policies, users } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { createTestApp, inject } from './support/create-test-app.js';

describe('관리자 약관 버전', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let admin: AuthUser;
  const userIds: string[] = [];
  const versions: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `약관${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 1 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (user: AuthUser, method: 'GET' | 'POST', url: string, payload?: object) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  // 다른 테스트의 약관 동의에 영향을 주지 않도록 먼 미래에 시행한다
  const create = (body: object) => call(admin, 'POST', '/admin/policies', body);
  const version = () => {
    const value = `t${newId().slice(-8)}`;
    versions.push(value);
    return value;
  };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    admin = await makeUser({ role: 'TEACHER', isAdmin: true });
  });

  afterAll(async () => {
    if (versions.length > 0) await db.delete(policies).where(inArray(policies.version, versions));
    await db.delete(auditLogs).where(inArray(auditLogs.actorId, userIds));
    await app.close();
  });

  it('시행 전 버전을 등록하고, 시행일 전에는 현재 약관이 바뀌지 않는다', async () => {
    const v = version();
    const res = await create({
      type: 'TERMS',
      version: v,
      title: '이용약관 개정',
      content: '# 바뀐 약관',
      effectiveAt: '2099-01-01T00:00:00.000Z',
      requireReagreement: true,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ version: v });

    const list = (await call(admin, 'GET', '/admin/policies?type=TERMS')).json();
    expect(list.find((p: { version: string }) => p.version === v)).toMatchObject({
      upcoming: true,
      requireReagreement: true,
      required: true,
    });
    const current = await call(admin, 'GET', '/policies/TERMS');
    if (current.statusCode === 200) expect(current.json().version).not.toBe(v);
    expect(
      await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.actorId, admin.userId), eq(auditLogs.action, 'POLICY_CREATE'))),
    ).toHaveLength(1);

    expect(
      (
        await create({
          type: 'TERMS',
          version: v,
          title: '중복',
          content: '내용',
          effectiveAt: '2099-02-01T00:00:00.000Z',
        })
      ).json().code,
    ).toBe('POLICY_VERSION_EXISTS');
  });

  it('필수 여부를 비우면 직전 버전을 따르고, 지난 시행일은 거절한다', async () => {
    const first = version();
    await create({
      type: 'MARKETING',
      version: first,
      title: '마케팅',
      content: '내용',
      effectiveAt: '2099-03-01T00:00:00.000Z',
      required: false,
    });
    const next = version();
    await create({
      type: 'MARKETING',
      version: next,
      title: '마케팅 개정',
      content: '내용',
      effectiveAt: '2099-04-01T00:00:00.000Z',
    });
    const [row] = await db
      .select()
      .from(policies)
      .where(and(eq(policies.type, 'MARKETING'), eq(policies.version, next)));
    expect(row?.required).toBe(false);

    const past = await create({
      type: 'PRIVACY',
      version: version(),
      title: '과거',
      content: '내용',
      effectiveAt: '2000-01-01T00:00:00.000Z',
    });
    expect(past.statusCode).toBe(400);
  });

  it('관리자만 쓸 수 있다', async () => {
    const student = await makeUser();
    expect((await call(student, 'GET', '/admin/policies')).statusCode).toBe(403);
  });
});
