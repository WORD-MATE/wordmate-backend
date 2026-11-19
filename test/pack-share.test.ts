import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { forbiddenWords, packCopies, packs, users, words } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { ForbiddenWordsService } from '../src/modules/forbidden-words/forbidden-words.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

describe('단어팩 공유·복사', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];

  const makeUser = async (
    overrides: Partial<typeof users.$inferInsert> = {},
  ): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    await db.insert(users).values({
      id: userId,
      name: '공유유저',
      role: 'STUDENT',
      grade: 2,
      classNo: 1,
      ...overrides,
    });
    return { userId, role: 'STUDENT', isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
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

  const createPack = async (user: AuthUser, name = `팩 ${randomUUID().slice(0, 8)}`, count = 0) => {
    const res = await call(user, 'POST', '/packs', { name });
    expect(res.statusCode).toBe(201);
    const { packId } = res.json();
    if (count > 0) {
      const added = await call(user, 'POST', `/packs/${packId}/words`, {
        words: Array.from({ length: count }, (_, i) => ({
          english: `word${i}`,
          meanings: [`뜻${i}`],
        })),
      });
      expect(added.json().added).toBe(count);
    }
    return packId as string;
  };

  const share = async (user: AuthUser, packId: string) =>
    call(user, 'POST', `/packs/${packId}/share`);

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
  });

  afterAll(async () => {
    const owned = await db
      .select({ id: packs.id })
      .from(packs)
      .where(inArray(packs.ownerUserId, userIds));
    const defaults = await db.select({ id: packs.id }).from(packs).where(eq(packs.type, 'DEFAULT'));
    const ids = [...owned, ...defaults].map((row) => row.id);
    if (ids.length > 0) {
      await db.delete(packCopies).where(inArray(packCopies.sourcePackId, ids));
      await db.delete(words).where(inArray(words.packId, ids));
      await db.update(packs).set({ copiedFromPackId: null }).where(inArray(packs.id, ids));
      await db.delete(packs).where(inArray(packs.id, ids));
    }
    await db.delete(forbiddenWords);
    await app.close();
  });

  it('공유 링크를 만들고, 다시 요청하면 같은 코드를 돌려준다', async () => {
    const owner = await makeUser();
    const empty = await createPack(owner);
    expect((await share(owner, empty)).json().code).toBe('PACK_EMPTY');

    const packId = await createPack(owner, '공유 팩', 2);
    const first = await share(owner, packId);
    expect(first.statusCode).toBe(200);
    const { shareCode } = first.json();
    expect(shareCode).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(first.json().url).toBe(`wordmate://packs/shared/${shareCode}`);
    expect((await share(owner, packId)).json().shareCode).toBe(shareCode);

    const detail = (await call(owner, 'GET', `/packs/${packId}`)).json();
    expect(detail).toMatchObject({ shared: true, share: { shareCode } });
  });

  it('남의 팩·기본 팩은 공유할 수 없다', async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const packId = await createPack(owner, undefined, 1);
    expect((await share(other, packId)).statusCode).toBe(403);

    const admin = await makeUser({ isAdmin: true });
    const created = await call(admin, 'POST', '/packs', { name: '기본 공유', type: 'DEFAULT' });
    expect((await share(admin, created.json().packId)).statusCode).toBe(403);
  });

  it('공유할 때 단어까지 금칙어를 검사하고 어떤 단어인지 알려준다', async () => {
    await db.insert(forbiddenWords).values({ word: 'badword', type: 'FORBIDDEN' });
    app.get(ForbiddenWordsService).clearCache();

    const owner = await makeUser();
    const packId = await createPack(owner, undefined, 1);
    const bad = await call(owner, 'POST', `/packs/${packId}/words`, {
      words: [{ english: 'fine', meanings: ['괜찮은', 'Bad Word'] }],
    });
    const badWordId = bad.json().words[0].wordId;

    const res = await share(owner, packId);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      code: 'FORBIDDEN_WORD',
      detail: { field: 'meanings', wordId: badWordId },
    });
    expect((await call(owner, 'GET', `/packs/${packId}`)).json().shared).toBe(false);

    await db.delete(forbiddenWords);
    app.get(ForbiddenWordsService).clearCache();
  });

  it('미리보기: 단어는 20개까지, 보는 사람 기준으로 isMine·alreadyCopied', async () => {
    const owner = await makeUser({ name: '김공유', avatarId: 'fox' });
    const viewer = await makeUser();
    const packId = await createPack(owner, '미리보기 팩', 25);
    const { shareCode } = (await share(owner, packId)).json();

    const res = await call(viewer, 'GET', `/packs/shared/${shareCode}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      name: '미리보기 팩',
      description: null,
      wordCount: 25,
      owner: { userId: owner.userId, name: '김공유', grade: 2, classNo: 1, avatarId: 'fox' },
      alreadyCopied: false,
      isMine: false,
    });
    expect(body.previewWords).toHaveLength(20);
    expect(body.previewWords[0]).toMatchObject({
      english: 'word0',
      memoryStatus: null,
      favorite: false,
    });

    expect((await call(owner, 'GET', `/packs/shared/${shareCode}`)).json().isMine).toBe(true);
    expect((await call(viewer, 'GET', '/packs/shared/AAAAAAAAAAAA')).json().code).toBe(
      'PACK_SHARE_NOT_FOUND',
    );
  });

  it('복사: 단어까지 독립된 내 팩으로, 한 번만, 이름이 겹치면 (2)', async () => {
    const owner = await makeUser();
    const copier = await makeUser();
    const source = await createPack(owner, '토익 단어', 3);
    const { shareCode } = (await share(owner, source)).json();
    await createPack(copier, '토익 단어');

    const res = await call(copier, 'POST', `/packs/shared/${shareCode}/copy`);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      type: 'MINE',
      name: '토익 단어 (2)',
      wordCount: 3,
      shared: false,
    });
    const copiedId = res.json().packId;

    const copiedWords = (await call(copier, 'GET', `/packs/${copiedId}/words`)).json().items;
    expect(copiedWords.map((w: { english: string }) => w.english)).toEqual([
      'word0',
      'word1',
      'word2',
    ]);

    // 원본을 고쳐도 복사본은 그대로
    await call(owner, 'POST', `/packs/${source}/words`, {
      words: [{ english: 'later', meanings: ['나중'] }],
    });
    expect((await call(copier, 'GET', `/packs/${copiedId}`)).json().wordCount).toBe(3);

    expect((await call(copier, 'GET', `/packs/shared/${shareCode}`)).json().alreadyCopied).toBe(
      true,
    );
    expect((await call(copier, 'POST', `/packs/shared/${shareCode}/copy`)).json().code).toBe(
      'PACK_ALREADY_COPIED',
    );
    expect((await call(owner, 'POST', `/packs/shared/${shareCode}/copy`)).json().code).toBe(
      'PACK_COPY_OWN',
    );

    // 복사본을 지우면 다시 복사할 수 있다
    await call(copier, 'DELETE', `/packs/${copiedId}`);
    expect((await call(copier, 'GET', `/packs/shared/${shareCode}`)).json().alreadyCopied).toBe(
      false,
    );
    const again = await call(copier, 'POST', `/packs/shared/${shareCode}/copy`);
    expect(again.statusCode).toBe(201);
    expect(again.json().wordCount).toBe(4);
  });

  it('공유를 중지하면 링크가 무효가 되고, 다시 공유하면 새 코드', async () => {
    const owner = await makeUser();
    const viewer = await makeUser();
    const packId = await createPack(owner, undefined, 1);
    const { shareCode } = (await share(owner, packId)).json();

    expect((await call(owner, 'DELETE', `/packs/${packId}/share`)).statusCode).toBe(204);
    expect((await call(owner, 'DELETE', `/packs/${packId}/share`)).statusCode).toBe(204);
    expect((await call(viewer, 'GET', `/packs/shared/${shareCode}`)).statusCode).toBe(404);
    expect((await call(owner, 'GET', `/packs/${packId}`)).json().share).toBeNull();

    const renewed = (await share(owner, packId)).json().shareCode;
    expect(renewed).not.toBe(shareCode);
    expect((await call(viewer, 'POST', `/packs/shared/${shareCode}/copy`)).statusCode).toBe(404);

    await call(owner, 'DELETE', `/packs/${packId}`);
    expect((await call(viewer, 'GET', `/packs/shared/${renewed}`)).statusCode).toBe(404);
  });
});
