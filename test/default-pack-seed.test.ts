import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { packCategories, packs, users, words } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import {
  applyDefaultPackSeed,
  DefaultPackSeed,
} from '../src/modules/packs/seed/default-pack-seed.js';
import { createTestApp, inject } from './support/create-test-app.js';

describe('기본 단어팩 시드', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const tag = newId().slice(-6);
  const categoryName = `분류${tag}`;
  const packName = `시드팩 ${tag}`;

  const seed = (
    wordsInPack: { english: string; meanings: string[]; example?: string }[],
    sortOrder = 1,
  ) =>
    DefaultPackSeed.parse({
      categories: [{ name: categoryName, sortOrder }],
      packs: [{ name: packName, category: categoryName, description: '설명', words: wordsInPack }],
    });

  const packRow = async () =>
    (
      await db
        .select()
        .from(packs)
        .where(and(eq(packs.type, 'DEFAULT'), eq(packs.name, packName), isNull(packs.deletedAt)))
    )[0];
  const activeWords = async (packId: string) =>
    db
      .select()
      .from(words)
      .where(and(eq(words.packId, packId), isNull(words.deletedAt)))
      .orderBy(words.id);

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
  });

  afterAll(async () => {
    const rows = await db.select({ id: packs.id }).from(packs).where(eq(packs.name, packName));
    const ids = rows.map((row) => row.id);
    if (ids.length > 0) {
      await db.delete(words).where(inArray(words.packId, ids));
      await db.delete(packs).where(inArray(packs.id, ids));
    }
    await db.delete(packCategories).where(eq(packCategories.name, categoryName));
    await app.close();
  });

  it('처음 넣으면 만들고, 같은 파일을 다시 넣으면 아무것도 바뀌지 않는다', async () => {
    const first = seed([
      { english: 'abandon', meanings: ['버리다', '포기하다'], example: 'Abandon ship.' },
      { english: 'look up', meanings: ['찾아보다'] },
    ]);
    expect(await applyDefaultPackSeed(db, first)).toEqual({
      categories: { created: 1, updated: 0 },
      packs: { created: 1, updated: 0 },
      words: { created: 2, updated: 0, removed: 0 },
    });
    expect(await applyDefaultPackSeed(db, first)).toEqual({
      categories: { created: 0, updated: 0 },
      packs: { created: 0, updated: 0 },
      words: { created: 0, updated: 0, removed: 0 },
    });

    const pack = await packRow();
    expect(pack).toMatchObject({ wordCount: 2, description: '설명', ownerUserId: null });
    const [category] = await db
      .select()
      .from(packCategories)
      .where(eq(packCategories.name, categoryName));
    expect(pack?.categoryId).toBe(category?.id);
    const saved = await activeWords(pack?.id as string);
    expect(saved[0]).toMatchObject({
      english: 'abandon',
      englishNorm: 'abandon',
      meaningsText: '버리다 포기하다',
      example: 'Abandon ship.',
    });

    // 앱 API로도 보이고 뜻으로 검색된다
    const userId = newId();
    await db
      .insert(users)
      .values({ id: userId, name: '시드확인', role: 'STUDENT', grade: 1, classNo: 1 });
    const viewer: AuthUser = { userId, role: 'STUDENT', isAdmin: false, deviceId: newId() };
    const token = await app.get(AccessTokenService).sign(viewer);
    const search = await inject(app, {
      method: 'GET',
      url: `/words/search?q=${encodeURIComponent('포기하다')}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(search.json().items.map((hit: { pack: { name: string } }) => hit.pack.name)).toContain(
      packName,
    );
  });

  it('바뀐 것만 고치고, prune이면 파일에 없는 단어를 지운다', async () => {
    const pack = await packRow();
    const changed = seed(
      [
        { english: 'abandon', meanings: ['버리다'] },
        { english: 'invoice', meanings: ['송장'] },
      ],
      5,
    );
    expect(await applyDefaultPackSeed(db, changed)).toEqual({
      categories: { created: 0, updated: 1 },
      packs: { created: 0, updated: 0 },
      words: { created: 1, updated: 1, removed: 0 },
    });
    // prune 없이는 파일에 없는 'look up'도 남는다
    expect((await activeWords(pack?.id as string)).map((w) => w.english).sort()).toEqual([
      'abandon',
      'invoice',
      'look up',
    ]);
    expect((await packRow())?.wordCount).toBe(3);

    expect((await applyDefaultPackSeed(db, changed, { prune: true })).words).toEqual({
      created: 0,
      updated: 0,
      removed: 1,
    });
    expect((await activeWords(pack?.id as string)).map((w) => w.english).sort()).toEqual([
      'abandon',
      'invoice',
    ]);
    expect(await packRow()).toMatchObject({ id: pack?.id, wordCount: 2 });
  });
});
