import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { packs, users, words } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { createTestApp, inject } from './support/create-test-app.js';
import { xlsx } from './support/xlsx-fixture.js';

describe('단어 파일 가져오기', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];
  let owner: AuthUser;
  let other: AuthUser;
  let packId: string;

  const makeUser = async (): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    await db.insert(users).values({ id: userId, name: '가져오기', role: 'STUDENT' });
    return { userId, role: 'STUDENT', isAdmin: false, deviceId: newId() };
  };

  const authorization = async (user: AuthUser) =>
    `Bearer ${await app.get(AccessTokenService).sign(user)}`;

  const upload = async (user: AuthUser, content: Buffer, field = 'file', target = packId) => {
    const boundary = `----wordmate${randomUUID()}`;
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="words.dat"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return inject(app, {
      method: 'POST',
      url: `/packs/${target}/words/import`,
      payload,
      headers: {
        authorization: await authorization(user),
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
    });
  };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    owner = await makeUser();
    other = await makeUser();
    const res = await inject(app, {
      method: 'POST',
      url: '/packs',
      payload: { name: '가져오기 팩' },
      headers: { authorization: await authorization(owner) },
    });
    packId = res.json().packId;
    await inject(app, {
      method: 'POST',
      url: `/packs/${packId}/words`,
      payload: { words: [{ english: 'apple', meanings: ['사과'] }] },
      headers: { authorization: await authorization(owner) },
    });
  });

  afterAll(async () => {
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

  it('CSV를 분석해 텍스트 분석과 같은 형식으로 돌려준다 (저장 안 함)', async () => {
    const csv = '﻿영어,뜻\r\nApple,"사과, 능금"\r\nbanana,\r\n';
    const res = await upload(owner, Buffer.from(csv));
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual([
      { line: 2, english: 'Apple', meanings: ['사과', '능금'], error: null, duplicate: true },
      { line: 3, english: 'banana', meanings: [], error: 'EMPTY_MEANING', duplicate: false },
    ]);
    const detail = await inject(app, {
      method: 'GET',
      url: `/packs/${packId}`,
      headers: { authorization: await authorization(owner) },
    });
    expect(detail.json().wordCount).toBe(1);
  });

  it('XLSX의 첫 번째 시트를 읽는다', async () => {
    const res = await upload(owner, xlsx([['run', '달리다, 운영하다']], true));
    expect(res.statusCode).toBe(200);
    expect(res.json().rows).toEqual([
      { line: 1, english: 'run', meanings: ['달리다', '운영하다'], error: null, duplicate: false },
    ]);
  });

  it('형식·인코딩·크기 오류', async () => {
    const xls = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00]);
    expect((await upload(owner, xls)).json().code).toBe('WORD_FILE_TYPE_UNSUPPORTED');

    const eucKr = Buffer.from([0x61, 0x2c, 0xbb, 0xe7, 0xb0, 0xfa]);
    expect((await upload(owner, eucKr)).json().code).toBe('WORD_FILE_ENCODING_INVALID');

    const tooLarge = await upload(owner, Buffer.alloc(5 * 1024 * 1024 + 1, 0x61));
    expect(tooLarge.statusCode).toBe(400);
    expect(tooLarge.json().code).toBe('WORD_FILE_TOO_LARGE');
  });

  it('전역 본문 한도(1MB)보다 큰 5MB 이하 파일도 받는다', async () => {
    const longMeaning = '뜻'.repeat(700);
    const csv = Array.from({ length: 1000 }, (_, i) => `w${i},${longMeaning}`).join('\n');
    expect(Buffer.byteLength(csv)).toBeGreaterThan(2 * 1024 * 1024);
    const res = await upload(owner, Buffer.from(csv));
    expect(res.statusCode).toBe(200);
    expect(res.json().rows[0].error).toBe('TOO_LONG');
  });

  it('file 필드가 없거나 multipart가 아니면 400', async () => {
    expect((await upload(owner, Buffer.from('a,b'), 'other')).statusCode).toBe(400);
    const json = await inject(app, {
      method: 'POST',
      url: `/packs/${packId}/words/import`,
      payload: { file: 'a,b' },
      headers: { authorization: await authorization(owner) },
    });
    expect(json.statusCode).toBe(400);
  });

  it('남의 팩이면 파일을 읽기 전에 403', async () => {
    expect((await upload(other, Buffer.from('a,b'))).statusCode).toBe(403);
  });
});
