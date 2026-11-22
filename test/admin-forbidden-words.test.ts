import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  auditLogs,
  forbiddenWords,
  type NewUser,
  packs,
  users,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { ForbiddenWordsService } from '../src/modules/forbidden-words/forbidden-words.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

describe('관리자 금칙어', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let admin: AuthUser;
  const userIds: string[] = [];
  const created: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `금칙${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 2 : null,
      classNo: role === 'STUDENT' ? 2 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (
    user: AuthUser,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const tag = () =>
    newId()
      .replace(/[^a-z]/g, '')
      .slice(0, 6);
  const createPack = (user: AuthUser, name: string) => call(user, 'POST', '/packs', { name });

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    admin = await makeUser({ role: 'TEACHER', isAdmin: true });
  });

  afterAll(async () => {
    if (created.length > 0) {
      await db.delete(forbiddenWords).where(inArray(forbiddenWords.word, created));
    }
    await db.delete(packs).where(inArray(packs.ownerUserId, userIds));
    await db.delete(auditLogs).where(inArray(auditLogs.actorId, userIds));
    await app.close();
  });

  it('등록·수정·삭제가 바로 검사에 반영된다', async () => {
    const student = await makeUser();
    const word = `금지${tag()}`;
    created.push(word);
    const res = await call(admin, 'POST', '/admin/forbidden-words', {
      type: 'FORBIDDEN',
      word: `  ${word}  `,
    });
    expect(res.statusCode).toBe(201);
    const { wordId } = res.json();
    expect((await createPack(student, `팩 ${word}`)).json().code).toBe('FORBIDDEN_WORD');
    expect(
      (await call(admin, 'POST', '/admin/forbidden-words', { type: 'FORBIDDEN', word })).json()
        .code,
    ).toBe('ADMIN_FORBIDDEN_WORD_DUPLICATE');

    const list = (
      await call(
        admin,
        'GET',
        `/admin/forbidden-words?type=FORBIDDEN&q=${encodeURIComponent(word)}`,
      )
    ).json();
    expect(list.items).toEqual([
      expect.objectContaining({ wordId, type: 'FORBIDDEN', word, createdBy: expect.any(String) }),
    ]);

    const renamed = `바뀐${tag()}`;
    created.push(renamed);
    expect(
      (await call(admin, 'PATCH', `/admin/forbidden-words/${wordId}`, { word: renamed }))
        .statusCode,
    ).toBe(204);
    expect((await createPack(student, `팩 ${word}`)).statusCode).toBe(201);
    expect((await createPack(student, `팩 ${renamed}`)).json().code).toBe('FORBIDDEN_WORD');

    expect((await call(admin, 'DELETE', `/admin/forbidden-words/${wordId}`)).statusCode).toBe(204);
    expect((await createPack(student, `새 팩 ${renamed}`)).statusCode).toBe(201);
    expect((await call(admin, 'DELETE', `/admin/forbidden-words/${wordId}`)).json().code).toBe(
      'ADMIN_FORBIDDEN_WORD_NOT_FOUND',
    );
  });

  it('다른 서버가 바꿔도 버전이 오르면 다시 읽는다', async () => {
    const service = app.get(ForbiddenWordsService);
    const word = `원격${tag()}`;
    created.push(word);
    await service.assertClean({ name: '데우기' });
    await db.insert(forbiddenWords).values({ id: newId(), type: 'FORBIDDEN', word });
    // 캐시가 남아 있으면 아직 통과한다
    await expect(service.assertClean({ name: word })).resolves.toBeUndefined();
    await app.get<Redis>(VALKEY).set('forbidden-words:version', newId());
    // 버전은 1초에 한 번만 확인하므로 곧 반영된다
    await expect
      .poll(
        () =>
          service.assertClean({ name: word }).then(
            () => 'clean',
            (error: { code?: string }) => error.code,
          ),
        { timeout: 5_000, interval: 300 },
      )
      .toBe('FORBIDDEN_WORD');
  });

  it('관리자만 쓸 수 있다', async () => {
    const student = await makeUser();
    expect((await call(student, 'GET', '/admin/forbidden-words')).statusCode).toBe(403);
  });
});
