import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { inArray, like } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { battleRooms, packs, users } from '../src/infra/db/schema/index.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import {
  cleanupLoadUsers,
  createLoadUsers,
  issueLoadTokens,
  LOAD_USER_MARK,
} from '../src/load-test/load-users.js';
import { createTestApp, inject } from './support/create-test-app.js';

describe('부하 테스트 계정', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let valkey: Redis;

  const call = (token: string, method: 'GET' | 'POST', url: string, payload?: object) =>
    inject(app, { method, url, payload, headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    valkey = app.get(VALKEY);
    await cleanupLoadUsers(db, valkey);
  });

  afterAll(async () => {
    await cleanupLoadUsers(db, valkey);
    await app.close();
  });

  it('만들면 약관에 동의된 학생이라 바로 API를 쓰고, 다시 만들어도 늘지 않는다', async () => {
    expect((await createLoadUsers(db, 4)).users).toBe(4);
    expect((await createLoadUsers(db, 4)).users).toBe(4);
    const tokens = await issueLoadTokens(db, app.get(AccessTokenService));
    expect(tokens).toHaveLength(4);
    for (const { token } of tokens) {
      expect((await call(token, 'GET', '/battles/history')).statusCode).toBe(200);
    }
    const rows = await db
      .select({ grade: users.grade, classNo: users.classNo, rankingPublic: users.rankingPublic })
      .from(users)
      .where(like(users.datagsmId, `${LOAD_USER_MARK}%`));
    expect(rows.every((row) => row.grade !== null && row.classNo !== null)).toBe(true);
    expect(rows.every((row) => !row.rankingPublic)).toBe(true);
  });

  it('지우면 만든 방·팩·랭킹·대기열 기록까지 함께 지운다', async () => {
    const [host] = await issueLoadTokens(db, app.get(AccessTokenService));
    const token = host?.token as string;
    const packId = (await call(token, 'POST', '/packs', { name: '부하팩' })).json().packId;
    await call(token, 'POST', `/packs/${packId}/words`, {
      words: Array.from({ length: 10 }, (_, i) => ({
        english: `load${i}`,
        meanings: [`부하${i}`],
      })),
    });
    const room = await call(token, 'POST', '/battles/rooms', {
      packId,
      questionType: 'KO_TO_EN_CHOICE',
      questionCount: 10,
      timeLimitSec: 10,
      maxParticipants: 2,
    });
    expect(room.statusCode).toBe(201);
    await valkey.zadd('rank:weekly:test:school', 10, host?.userId as string);
    await valkey.zadd('mm:queue', 0, host?.userId as string);

    expect(await cleanupLoadUsers(db, valkey)).toBe(4);
    expect(
      await db
        .select()
        .from(users)
        .where(like(users.datagsmId, `${LOAD_USER_MARK}%`)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(battleRooms)
        .where(inArray(battleRooms.id, [room.json().roomId])),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(packs)
        .where(inArray(packs.id, [packId])),
    ).toEqual([]);
    expect(await valkey.zscore('rank:weekly:test:school', host?.userId as string)).toBeNull();
    expect(await valkey.zscore('mm:queue', host?.userId as string)).toBeNull();
    await valkey.del('rank:weekly:test:school');
  });
});
