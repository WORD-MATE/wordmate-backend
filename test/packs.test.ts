import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { forbiddenWords, packCategories, packs, users } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { ForbiddenWordsService } from '../src/modules/forbidden-words/forbidden-words.service.js';
import { MAX_PACKS_PER_USER } from '../src/modules/packs/packs.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

describe('단어팩', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];
  const categoryId = newId();

  const makeUser = async (isAdmin = false): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    await db.insert(users).values({ id: userId, name: '팩유저', role: 'STUDENT', isAdmin });
    return { userId, role: 'STUDENT', isAdmin, deviceId: newId() };
  };

  let student: AuthUser;
  let other: AuthUser;
  let admin: AuthUser;

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

  const createPack = (user: AuthUser, payload: object) => call(user, 'POST', '/packs', payload);

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    student = await makeUser();
    other = await makeUser();
    admin = await makeUser(true);
    await db.insert(packCategories).values([
      { id: categoryId, name: '수능', sortOrder: 1 },
      { name: '토익', sortOrder: 2 },
    ]);
  });

  afterAll(async () => {
    await db.delete(packs).where(inArray(packs.ownerUserId, userIds));
    await db.delete(packs).where(inArray(packs.type, ['DEFAULT']));
    await db.delete(packCategories);
    await db.delete(forbiddenWords);
    await app.close();
  });

  it('내 단어팩을 만들고 목록·상세에서 본다', async () => {
    const res = await createPack(student, { name: ' 영단어 1 ', description: '' });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      packId: expect.any(String),
      type: 'MINE',
      name: '영단어 1',
      description: null,
      categoryId: null,
      wordCount: 0,
      progress: { studied: 0, total: 0 },
      lastStudiedAt: null,
      shared: false,
    });
    const { packId } = res.json();

    const list = await call(student, 'GET', '/packs?type=MINE');
    expect(list.json()).toEqual({ items: [expect.objectContaining({ packId })], nextCursor: null });

    const detail = await call(student, 'GET', `/packs/${packId}`);
    expect(detail.json()).toMatchObject({
      packId,
      editable: true,
      memoryStatusCount: { NEW: 0, LEARNING: 0, MEMORIZED: 0 },
      share: null,
    });
  });

  it('이름 검증: 공백만은 400, 31자는 400, 대소문자만 다른 같은 이름은 409, 삭제하면 다시 쓸 수 있다', async () => {
    expect((await createPack(student, { name: '   ' })).statusCode).toBe(400);
    expect((await createPack(student, { name: 'a'.repeat(31) })).statusCode).toBe(400);

    const first = (await createPack(student, { name: 'My Pack' })).json();
    const dup = await createPack(student, { name: 'my pack' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('PACK_NAME_DUPLICATE');
    expect((await createPack(other, { name: 'My Pack' })).statusCode).toBe(201);

    expect((await call(student, 'DELETE', `/packs/${first.packId}`)).statusCode).toBe(204);
    expect((await call(student, 'GET', `/packs/${first.packId}`)).json().code).toBe(
      'PACK_NOT_FOUND',
    );
    expect((await createPack(student, { name: 'My Pack' })).statusCode).toBe(201);
  });

  it('이름·설명에 금칙어가 있으면 400 FORBIDDEN_WORD, 허용 단어는 통과', async () => {
    await db.insert(forbiddenWords).values([
      { word: 'ass', type: 'FORBIDDEN' },
      { word: 'class', type: 'ALLOWED' },
    ]);
    app.get(ForbiddenWordsService).clearCache();

    const byName = await createPack(student, { name: 'smart a.s.s' });
    expect(byName.statusCode).toBe(400);
    expect(byName.json()).toMatchObject({ code: 'FORBIDDEN_WORD', detail: { field: 'name' } });

    const byDescription = await createPack(student, { name: '설명 검사', description: 'ASS' });
    expect(byDescription.json().detail).toEqual({ field: 'description' });

    expect((await createPack(student, { name: 'Class words' })).statusCode).toBe(201);
  });

  it('남의 내 단어팩은 403, 없는 팩은 404', async () => {
    const { packId } = (await createPack(student, { name: '비공개 팩' })).json();
    expect((await call(other, 'GET', `/packs/${packId}`)).statusCode).toBe(403);
    expect((await call(other, 'PATCH', `/packs/${packId}`, { name: 'x' })).statusCode).toBe(403);
    expect((await call(other, 'DELETE', `/packs/${packId}`)).statusCode).toBe(403);
    expect((await call(admin, 'PATCH', `/packs/${packId}`, { name: 'x' })).statusCode).toBe(403);
    expect((await call(student, 'GET', `/packs/${newId()}`)).statusCode).toBe(404);
  });

  it('기본 단어팩은 관리자만 만들고 고친다, 분류로 거를 수 있다', async () => {
    expect((await createPack(student, { name: '기본', type: 'DEFAULT' })).statusCode).toBe(403);

    const created = await createPack(admin, { name: '수능 필수', type: 'DEFAULT', categoryId });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ type: 'DEFAULT', categoryId });
    const { packId } = created.json();
    await createPack(admin, { name: '분류 없음', type: 'DEFAULT' });

    const unknownCategory = await createPack(admin, {
      name: '분류 오류',
      type: 'DEFAULT',
      categoryId: newId(),
    });
    expect(unknownCategory.statusCode).toBe(400);

    const filtered = await call(student, 'GET', `/packs?type=DEFAULT&categoryId=${categoryId}`);
    expect(filtered.json().items.map((p: { packId: string }) => p.packId)).toEqual([packId]);

    expect((await call(student, 'GET', `/packs/${packId}`)).json().editable).toBe(false);
    expect((await call(student, 'PATCH', `/packs/${packId}`, { name: 'x' })).statusCode).toBe(403);

    const updated = await call(admin, 'PATCH', `/packs/${packId}`, {
      name: '수능 필수 2',
      categoryId: null,
    });
    expect(updated.json()).toMatchObject({ name: '수능 필수 2', categoryId: null });
  });

  it('이름순 정렬과 커서 페이지, 이름 검색', async () => {
    const user = await makeUser();
    for (const name of ['다람쥐', '가방', '나비', '라면']) await createPack(user, { name });

    const first = (await call(user, 'GET', '/packs?type=MINE&sort=NAME&size=3')).json();
    expect(first.items.map((p: { name: string }) => p.name)).toEqual(['가방', '나비', '다람쥐']);
    const second = (
      await call(user, 'GET', `/packs?type=MINE&sort=NAME&size=3&cursor=${first.nextCursor}`)
    ).json();
    expect(second).toEqual({
      items: [expect.objectContaining({ name: '라면' })],
      nextCursor: null,
    });

    const searched = (await call(user, 'GET', '/packs?type=MINE&q=%EB%B9%84')).json();
    expect(searched.items.map((p: { name: string }) => p.name)).toEqual(['나비']);

    const recent = (await call(user, 'GET', '/packs?type=MINE')).json();
    expect(recent.items[0].name).toBe('라면');

    expect((await call(user, 'GET', '/packs?type=MINE&cursor=broken')).statusCode).toBe(400);
  });

  it(`내 단어팩은 ${MAX_PACKS_PER_USER}개까지`, async () => {
    const user = await makeUser();
    await db.insert(packs).values(
      Array.from({ length: MAX_PACKS_PER_USER }, (_, i) => ({
        type: 'MINE' as const,
        ownerUserId: user.userId,
        name: `팩 ${i}`,
      })),
    );
    const res = await createPack(user, { name: '하나 더' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'PACK_LIMIT_EXCEEDED',
      detail: { limit: MAX_PACKS_PER_USER },
    });
  });

  it('분류 목록은 정렬 순서대로', async () => {
    const res = await call(student, 'GET', '/packs/categories');
    expect(res.json()).toEqual([
      { categoryId, name: '수능' },
      { categoryId: expect.any(String), name: '토익' },
    ]);
  });
});
