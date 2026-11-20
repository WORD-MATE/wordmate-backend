import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { forbiddenWords, packs, users, words } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { ForbiddenWordsService } from '../src/modules/forbidden-words/forbidden-words.service.js';
import { MAX_WORDS_PER_PACK } from '../src/modules/words/words.schemas.js';
import { createTestApp, inject } from './support/create-test-app.js';

describe('단어', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];

  const makeUser = async (isAdmin = false): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    await db.insert(users).values({ id: userId, name: '단어유저', role: 'STUDENT', isAdmin });
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
    headers: Record<string, string> = {},
  ) =>
    inject(app, {
      method,
      url,
      payload,
      headers: {
        authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}`,
        ...headers,
      },
    });

  const createPack = async (user: AuthUser, payload: object = {}) => {
    const res = await call(user, 'POST', '/packs', {
      name: `팩 ${randomUUID().slice(0, 8)}`,
      ...payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json().packId as string;
  };

  const addWords = (user: AuthUser, packId: string, payload: object) =>
    call(user, 'POST', `/packs/${packId}/words`, payload);

  const wordCountOf = async (user: AuthUser, packId: string) =>
    (await call(user, 'GET', `/packs/${packId}`)).json().wordCount as number;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    student = await makeUser();
    other = await makeUser();
    admin = await makeUser(true);
  });

  afterAll(async () => {
    const packRows = await db
      .select({ id: packs.id })
      .from(packs)
      .where(inArray(packs.ownerUserId, userIds));
    const packIds = [...packRows.map((row) => row.id)];
    const defaults = await db.select({ id: packs.id }).from(packs).where(eq(packs.type, 'DEFAULT'));
    packIds.push(...defaults.map((row) => row.id));
    if (packIds.length > 0) {
      await db.delete(words).where(inArray(words.packId, packIds));
      await db.delete(packs).where(inArray(packs.id, packIds));
    }
    await db.delete(forbiddenWords);
    await app.close();
  });

  it('여러 개를 추가하고 목록에서 추가한 순서대로 본다', async () => {
    const packId = await createPack(student);
    const res = await addWords(student, packId, {
      words: [
        { english: ' Apple ', meanings: ['사과', '능금'] },
        { english: 'look   up', meanings: ['찾아보다'] },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ added: 2, skipped: 0, overwritten: 0, excluded: 0 });
    expect(res.json().words[0]).toEqual({
      wordId: expect.any(String),
      english: 'Apple',
      meanings: ['사과', '능금'],
      example: null,
      derivatives: [],
      memoryStatus: 'NEW',
      favorite: false,
    });

    const list = (await call(student, 'GET', `/packs/${packId}/words?size=1`)).json();
    expect(list.items.map((w: { english: string }) => w.english)).toEqual(['Apple']);
    const next = (
      await call(student, 'GET', `/packs/${packId}/words?size=1&cursor=${list.nextCursor}`)
    ).json();
    expect(next).toEqual({
      items: [expect.objectContaining({ english: 'look up' })],
      nextCursor: null,
    });

    expect(
      (await call(student, 'GET', `/packs/${packId}/words?memoryStatus=MEMORIZED`)).json().items,
    ).toEqual([]);
    expect(await wordCountOf(student, packId)).toBe(2);
  });

  it('중복 정책: SKIP은 건너뛰고 OVERWRITE는 뜻을 덮어쓴다, 요청 안 중복은 처음 것만', async () => {
    const packId = await createPack(student);
    await addWords(student, packId, { words: [{ english: 'run', meanings: ['달리다'] }] });

    const skipped = await addWords(student, packId, {
      words: [
        { english: 'RUN', meanings: ['운영하다'] },
        { english: 'walk', meanings: ['걷다'] },
        { english: 'Walk', meanings: ['산책'] },
      ],
    });
    expect(skipped.json()).toMatchObject({ added: 1, skipped: 2, overwritten: 0 });

    const overwritten = await addWords(student, packId, {
      duplicatePolicy: 'OVERWRITE',
      words: [{ english: 'Run', meanings: ['운영하다', '달리다'] }],
    });
    expect(overwritten.json()).toMatchObject({ added: 0, skipped: 0, overwritten: 1 });
    expect(overwritten.json().words[0]).toMatchObject({
      english: 'Run',
      meanings: ['운영하다', '달리다'],
    });
    expect(await wordCountOf(student, packId)).toBe(2);
  });

  it('검증: 뜻 0개·6개·중복, 51자 영어는 400', async () => {
    const packId = await createPack(student);
    for (const word of [
      { english: 'a', meanings: [] },
      { english: 'a', meanings: ['1', '2', '3', '4', '5', '6'] },
      { english: 'a', meanings: ['뜻', ' 뜻 '] },
      { english: 'a'.repeat(51), meanings: ['뜻'] },
      { english: '   ', meanings: ['뜻'] },
    ]) {
      expect((await addWords(student, packId, { words: [word] })).statusCode).toBe(400);
    }
  });

  it('내 단어팩에서는 example·derivatives를 버리고, 기본 단어팩에서는 저장한다', async () => {
    const mine = await createPack(student);
    const word = {
      english: 'happy',
      meanings: ['행복한'],
      example: 'I am happy.',
      derivatives: ['happiness'],
    };
    expect((await addWords(student, mine, { words: [word] })).json().words[0]).toMatchObject({
      example: null,
      derivatives: [],
    });

    const defaultPack = await createPack(admin, { type: 'DEFAULT' });
    expect((await addWords(admin, defaultPack, { words: [word] })).json().words[0]).toMatchObject({
      example: 'I am happy.',
      derivatives: ['happiness'],
    });
    expect((await addWords(student, defaultPack, { words: [word] })).statusCode).toBe(403);
  });

  it(`팩당 ${MAX_WORDS_PER_PACK}개를 넘는 단어는 저장하지 않고 excluded로 알려준다`, async () => {
    const packId = await createPack(student);
    await db.insert(words).values(
      Array.from({ length: MAX_WORDS_PER_PACK - 1 }, (_, i) => ({
        packId,
        english: `w${i}`,
        englishNorm: `w${i}`,
        meanings: ['뜻'],
      })),
    );
    await db
      .update(packs)
      .set({ wordCount: MAX_WORDS_PER_PACK - 1 })
      .where(eq(packs.id, packId));

    const res = await addWords(student, packId, {
      words: [
        { english: 'w0', meanings: ['덮어쓰기'] },
        { english: 'new1', meanings: ['뜻'] },
        { english: 'new2', meanings: ['뜻'] },
      ],
      duplicatePolicy: 'OVERWRITE',
    });
    expect(res.json()).toMatchObject({ added: 1, overwritten: 1, excluded: 1 });
    expect(await wordCountOf(student, packId)).toBe(MAX_WORDS_PER_PACK);
  });

  it('Idempotency-Key가 같으면 다시 추가하지 않고 처음 응답을 돌려준다', async () => {
    const packId = await createPack(student);
    const key = randomUUID();
    const payload = { words: [{ english: 'retry', meanings: ['재시도'] }] };
    const first = await call(student, 'POST', `/packs/${packId}/words`, payload, {
      'idempotency-key': key,
    });
    const second = await call(student, 'POST', `/packs/${packId}/words`, payload, {
      'idempotency-key': key,
    });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(await wordCountOf(student, packId)).toBe(1);
  });

  it('수정: 같은 팩의 다른 단어와 겹치면 409, 대소문자만 바꾸는 건 된다', async () => {
    const packId = await createPack(student);
    const added = (
      await addWords(student, packId, {
        words: [
          { english: 'cat', meanings: ['고양이'] },
          { english: 'dog', meanings: ['개'] },
        ],
      })
    ).json().words;
    const dogId = added[1].wordId;

    const dup = await call(student, 'PATCH', `/packs/${packId}/words/${dogId}`, { english: 'CAT' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('WORD_DUPLICATE');

    const renamed = await call(student, 'PATCH', `/packs/${packId}/words/${dogId}`, {
      english: 'Dog',
      meanings: ['개', '강아지'],
    });
    expect(renamed.json()).toMatchObject({ english: 'Dog', meanings: ['개', '강아지'] });

    const otherPack = await createPack(student);
    expect(
      (await call(student, 'PATCH', `/packs/${otherPack}/words/${dogId}`, { english: 'x' })).json()
        .code,
    ).toBe('WORD_NOT_FOUND');
  });

  it('삭제하면 wordCount가 줄고, 같은 단어를 다시 추가할 수 있다', async () => {
    const packId = await createPack(student);
    const [word] = (
      await addWords(student, packId, { words: [{ english: 'gone', meanings: ['사라진'] }] })
    ).json().words;

    expect(
      (await call(student, 'DELETE', `/packs/${packId}/words/${word.wordId}`)).statusCode,
    ).toBe(204);
    expect(
      (await call(student, 'DELETE', `/packs/${packId}/words/${word.wordId}`)).statusCode,
    ).toBe(404);
    expect(await wordCountOf(student, packId)).toBe(0);

    const again = await addWords(student, packId, {
      words: [{ english: 'gone', meanings: ['다시'] }],
    });
    expect(again.json()).toMatchObject({ added: 1 });
  });

  it('남의 내 단어팩 단어는 보기·추가·분석 모두 403', async () => {
    const packId = await createPack(student);
    expect((await call(other, 'GET', `/packs/${packId}/words`)).statusCode).toBe(403);
    expect(
      (await addWords(other, packId, { words: [{ english: 'x', meanings: ['y'] }] })).statusCode,
    ).toBe(403);
    expect(
      (await call(other, 'POST', `/packs/${packId}/words/parse`, { text: 'a / b' })).statusCode,
    ).toBe(403);
  });

  it('구분자 텍스트를 분석하고 이미 있는 단어를 표시한다 (저장 안 함)', async () => {
    const packId = await createPack(student);
    await addWords(student, packId, { words: [{ english: 'apple', meanings: ['사과'] }] });

    const res = await call(student, 'POST', `/packs/${packId}/words/parse`, {
      text: 'Apple / 사과, 능금\n\nbanana\tbanana, 바나나\nno separator\n / 뜻',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual([
      { line: 1, english: 'Apple', meanings: ['사과', '능금'], error: null, duplicate: true },
      { line: 3, english: 'banana', meanings: ['banana', '바나나'], error: null, duplicate: false },
      { line: 4, english: null, meanings: [], error: 'NO_SEPARATOR', duplicate: false },
      { line: 5, english: null, meanings: ['뜻'], error: 'EMPTY_ENGLISH', duplicate: false },
    ]);
    expect(await wordCountOf(student, packId)).toBe(1);

    const tooMany = Array.from({ length: MAX_WORDS_PER_PACK + 1 }, (_, i) => `w${i} / 뜻`).join(
      '\n',
    );
    expect(
      (await call(student, 'POST', `/packs/${packId}/words/parse`, { text: tooMany })).statusCode,
    ).toBe(400);
  });

  it('공유 중인 팩이면 단어도 금칙어 검사, 공유 전에는 검사하지 않는다', async () => {
    await db.insert(forbiddenWords).values({ word: 'badword', type: 'FORBIDDEN' });
    app.get(ForbiddenWordsService).clearCache();

    const packId = await createPack(student);
    const word = { english: 'ok', meanings: ['괜찮은', 'bad word'] };
    expect((await addWords(student, packId, { words: [word] })).statusCode).toBe(201);

    await db.update(packs).set({ shareCode: 'TESTSHARE001' }).where(eq(packs.id, packId));
    const res = await addWords(student, packId, {
      words: [{ english: 'fine', meanings: ['BAD-WORD'] }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'FORBIDDEN_WORD', detail: { field: 'meanings' } });

    // 뜻을 이어 붙여 검사하지 않으므로 경계를 넘는 조합은 걸리지 않는다
    const boundary = await addWords(student, packId, {
      words: [{ english: 'split', meanings: ['bad', 'word'] }],
    });
    expect(boundary.statusCode).toBe(201);
  });
});
