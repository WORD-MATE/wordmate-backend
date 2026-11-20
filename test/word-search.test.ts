import { randomInt } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { packCopies, packs, users, wordFavorites, words } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { createTestApp, inject } from './support/create-test-app.js';

// 다른 테스트 파일이 남긴 단어와 섞이지 않도록 이번 실행에만 쓰는 접두어
const tag = Array.from({ length: 6 }, () => 'bcdfghjkmnpqrstvwxz'[randomInt(19)]).join('');

type Hit = { word: { wordId: string; english: string; favorite: boolean }; pack: { name: string } };

describe('단어 검색·즐겨찾기', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];

  const makeUser = async (isAdmin = false): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    await db
      .insert(users)
      .values({ id: userId, name: '검색유저', role: 'STUDENT', grade: 2, classNo: 1, isAdmin });
    return { userId, role: 'STUDENT', isAdmin, deviceId: newId() };
  };

  const call = async (
    user: AuthUser,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const createPack = async (
    user: AuthUser,
    entries: [string, string[]][],
    type: 'MINE' | 'DEFAULT' = 'MINE',
  ) => {
    const created = await call(user, 'POST', '/packs', {
      name: `${tag} ${newId().slice(-6)}`,
      type,
    });
    expect(created.statusCode).toBe(201);
    const packId = created.json().packId as string;
    const added = await call(user, 'POST', `/packs/${packId}/words`, {
      words: entries.map(([english, meanings]) => ({ english, meanings })),
    });
    expect(added.json().added).toBe(entries.length);
    const ids = Object.fromEntries(
      added.json().words.map((w: { english: string; wordId: string }) => [w.english, w.wordId]),
    );
    return { packId, ids: ids as Record<string, string> };
  };

  const search = async (user: AuthUser, q: string, extra = '') => {
    const res = await call(user, 'GET', `/words/search?q=${encodeURIComponent(q)}${extra}`);
    expect(res.statusCode).toBe(200);
    return res.json() as { items: Hit[]; nextCursor: string | null };
  };
  const englishOf = (page: { items: Hit[] }) => page.items.map((hit) => hit.word.english);

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
    await db.delete(wordFavorites).where(inArray(wordFavorites.userId, userIds));
    if (ids.length > 0) {
      await db.delete(packCopies).where(inArray(packCopies.sourcePackId, ids));
      await db.delete(words).where(inArray(words.packId, ids));
      await db.update(packs).set({ copiedFromPackId: null }).where(inArray(packs.id, ids));
      await db.delete(packs).where(inArray(packs.id, ids));
    }
    await app.close();
  });

  it('영어·뜻 부분 일치, 대소문자 무시, 기본 팩 + 내 팩만', async () => {
    const me = await makeUser();
    const other = await makeUser();
    const admin = await makeUser(true);
    await createPack(me, [
      [`${tag}Station`, ['역', '정거장']],
      [`${tag}apple`, ['사과']],
      [`${tag}give up`, ['포기하다']],
    ]);
    await createPack(admin, [[`${tag}nation`, ['국가']]], 'DEFAULT');
    await createPack(other, [[`${tag}ration`, ['배급']]]);

    // 불용어(on, at …)가 들어간 토큰도 검색된다
    expect(englishOf(await search(me, `${tag}STAT`))).toEqual([`${tag}Station`]);
    expect(englishOf(await search(me, 'tion'))).toEqual(
      expect.arrayContaining([`${tag}nation`, `${tag}Station`]),
    );
    expect(englishOf(await search(me, 'tion'))).not.toContain(`${tag}ration`);

    expect(englishOf(await search(me, '정거'))).toContain(`${tag}Station`);
    expect(englishOf(await search(me, `${tag}give u`))).toEqual([`${tag}give up`]);
    expect(englishOf(await search(me, `${tag}gi up`))).toEqual([]);

    const hit = (await search(me, '국가')).items.find(
      (item) => item.word.english === `${tag}nation`,
    );
    expect(hit?.pack.name).toMatch(tag);
  });

  it('1글자 검색과 와일드카드 문자', async () => {
    const me = await makeUser();
    await createPack(me, [
      [`${tag}x`, ['꿻']],
      [`${tag}50%off`, ['할인']],
      [`${tag}500ff`, ['다른 것']],
      [`${tag}x-ray`, ['엑스선']],
    ]);
    expect(englishOf(await search(me, '꿻'))).toEqual([`${tag}x`]);
    expect(englishOf(await search(me, `${tag}x-r`))).toEqual([`${tag}x-ray`]);
    expect(englishOf(await search(me, 'x-ra'))).toContain(`${tag}x-ray`);
    expect(englishOf(await search(me, `${tag}50%`))).toEqual([`${tag}50%off`]);
    expect(englishOf(await search(me, `${tag}5_0`))).toEqual([]);

    const blank = await call(me, 'GET', '/words/search?q=%20%20');
    expect(blank.statusCode).toBe(400);
  });

  it('영어 알파벳순 커서 페이징, 삭제·수정한 단어 반영', async () => {
    const me = await makeUser();
    const { packId, ids } = await createPack(me, [
      [`${tag}page c`, ['페이지']],
      [`${tag}page A`, ['페이지']],
      [`${tag}page b`, ['페이지']],
      [`${tag}page d`, ['페이지']],
    ]);

    const first = await search(me, `${tag}page`, '&size=3');
    expect(englishOf(first)).toEqual([`${tag}page A`, `${tag}page b`, `${tag}page c`]);
    const second = await search(me, `${tag}page`, `&size=3&cursor=${first.nextCursor}`);
    expect(englishOf(second)).toEqual([`${tag}page d`]);
    expect(second.nextCursor).toBeNull();

    await call(me, 'DELETE', `/packs/${packId}/words/${ids[`${tag}page d`]}`);
    await call(me, 'PATCH', `/packs/${packId}/words/${ids[`${tag}page c`]}`, {
      meanings: ['바뀐뜻'],
    });
    expect(englishOf(await search(me, `${tag}page`))).toHaveLength(3);
    expect(englishOf(await search(me, '바뀐뜻'))).toEqual([`${tag}page c`]);
  });

  it('복사한 팩의 단어도 뜻으로 검색된다', async () => {
    const owner = await makeUser();
    const copier = await makeUser();
    const { packId } = await createPack(owner, [[`${tag}copied`, ['복사된뜻']]]);
    const { shareCode } = (await call(owner, 'POST', `/packs/${packId}/share`)).json();
    expect((await call(copier, 'POST', `/packs/shared/${shareCode}/copy`)).statusCode).toBe(201);
    expect(englishOf(await search(copier, '복사된뜻'))).toEqual([`${tag}copied`]);
  });

  it('즐겨찾기: 멱등 추가·해제, 남의 단어 404, 최근 순 목록, favorite 표시', async () => {
    const me = await makeUser();
    const other = await makeUser();
    const admin = await makeUser(true);
    const mine = await createPack(me, [
      [`${tag}fav one`, ['하나']],
      [`${tag}fav two`, ['둘']],
    ]);
    const basic = await createPack(admin, [[`${tag}fav basic`, ['기본']]], 'DEFAULT');
    const others = await createPack(other, [[`${tag}fav secret`, ['비밀']]]);

    const one = mine.ids[`${tag}fav one`];
    const two = mine.ids[`${tag}fav two`];
    const basicId = basic.ids[`${tag}fav basic`];
    expect((await call(me, 'PUT', `/words/${one}/favorite`)).statusCode).toBe(204);
    expect((await call(me, 'PUT', `/words/${one}/favorite`)).statusCode).toBe(204);
    expect((await call(me, 'PUT', `/words/${basicId}/favorite`)).statusCode).toBe(204);
    expect((await call(me, 'PUT', `/words/${two}/favorite`)).statusCode).toBe(204);

    const secret = await call(me, 'PUT', `/words/${others.ids[`${tag}fav secret`]}/favorite`);
    expect(secret.statusCode).toBe(404);
    expect(secret.json().code).toBe('WORD_NOT_FOUND');
    expect((await call(me, 'PUT', `/words/${newId()}/favorite`)).statusCode).toBe(404);

    // 같은 밀리초에 들어가면 순서가 흔들리므로 시각을 고정한다
    const favoritedAt = [one, basicId, two].map((wordId, i) => ({
      wordId: wordId as string,
      at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
    }));
    for (const { wordId, at } of favoritedAt) {
      await db
        .update(wordFavorites)
        .set({ createdAt: at })
        .where(and(eq(wordFavorites.userId, me.userId), eq(wordFavorites.wordId, wordId)));
    }

    const list = (await call(me, 'GET', '/words/favorites?size=2')).json();
    expect(list.items.map((item: Hit) => item.word.english)).toEqual([
      `${tag}fav two`,
      `${tag}fav basic`,
    ]);
    expect(list.items[0]).toMatchObject({ word: { favorite: true }, pack: { type: 'MINE' } });
    const rest = (
      await call(me, 'GET', `/words/favorites?size=2&cursor=${list.nextCursor}`)
    ).json();
    expect(rest.items.map((item: Hit) => item.word.english)).toEqual([`${tag}fav one`]);
    expect(rest.nextCursor).toBeNull();

    const packWords = (await call(me, 'GET', `/packs/${mine.packId}/words`)).json().items;
    expect(packWords.map((w: { favorite: boolean }) => w.favorite)).toEqual([true, true]);
    const found = (await search(me, `${tag}fav`)).items;
    expect(found.map((hit) => [hit.word.english, hit.word.favorite])).toEqual([
      [`${tag}fav basic`, true],
      [`${tag}fav one`, true],
      [`${tag}fav two`, true],
    ]);
    // 다른 사용자에게는 즐겨찾기가 아니다
    const forOther = (await search(other, `${tag}fav basic`)).items;
    expect(forOther.map((hit) => hit.word.favorite)).toEqual([false]);

    expect((await call(me, 'DELETE', `/words/${one}/favorite`)).statusCode).toBe(204);
    expect((await call(me, 'DELETE', `/words/${one}/favorite`)).statusCode).toBe(204);
    await call(me, 'DELETE', `/packs/${mine.packId}/words/${two}`);
    const after = (await call(me, 'GET', '/words/favorites')).json();
    expect(after.items.map((item: Hit) => item.word.english)).toEqual([`${tag}fav basic`]);
  });
});
