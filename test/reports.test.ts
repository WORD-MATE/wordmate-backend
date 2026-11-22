import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { type NewUser, packs, reports, users, words } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { createTestApp, inject } from './support/create-test-app.js';

describe('신고', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `신고${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 3 : null,
      classNo: role === 'STUDENT' ? 2 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (user: AuthUser, method: 'POST', url: string, payload?: object) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const report = (user: AuthUser, body: object) => call(user, 'POST', '/reports', body);

  const createPack = async (owner: AuthUser) => {
    const { packId } = (
      await call(owner, 'POST', '/packs', { name: `신고팩 ${newId().slice(-6)}` })
    ).json();
    await call(owner, 'POST', `/packs/${packId}/words`, {
      words: [{ english: 'report', meanings: ['신고'] }],
    });
    const [word] = await db.select({ id: words.id }).from(words).where(eq(words.packId, packId));
    return { packId: packId as string, wordId: (word as { id: string }).id };
  };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
  });

  afterAll(async () => {
    await db.delete(reports).where(inArray(reports.reporterId, userIds));
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

  it('사용자를 신고하면 접수되고, 같은 대상·사유는 하루 한 번', async () => {
    const [reporter, target] = await Promise.all([makeUser(), makeUser()]);
    const body = { targetType: 'USER', targetId: target.userId, reason: 'OFFENSIVE_REACTION' };
    const res = await report(reporter, body);
    expect(res.statusCode).toBe(201);
    const { reportId } = res.json();
    const [row] = await db.select().from(reports).where(eq(reports.id, reportId));
    expect(row).toMatchObject({
      reporterId: reporter.userId,
      targetType: 'USER',
      targetId: target.userId,
      status: 'RECEIVED',
      detail: null,
      battleId: null,
    });

    const again = await report(reporter, body);
    expect(again.statusCode).toBe(429);
    expect(again.json().code).toBe('REPORT_DUPLICATE_TODAY');
    expect((await report(reporter, { ...body, reason: 'CHEATING' })).statusCode).toBe(201);
    expect((await report(target, { ...body, targetId: reporter.userId })).statusCode).toBe(201);
  });

  it('기타 사유는 상세가 필요하고 200자까지', async () => {
    const [reporter, target] = await Promise.all([makeUser(), makeUser()]);
    const base = { targetType: 'USER', targetId: target.userId, reason: 'OTHER' };
    expect((await report(reporter, base)).statusCode).toBe(400);
    expect((await report(reporter, { ...base, detail: '   ' })).statusCode).toBe(400);
    expect((await report(reporter, { ...base, detail: '가'.repeat(201) })).statusCode).toBe(400);
    const ok = await report(reporter, { ...base, detail: ' 욕설을 했어요 ' });
    expect(ok.statusCode).toBe(201);
    const [row] = await db.select().from(reports).where(eq(reports.id, ok.json().reportId));
    expect(row?.detail).toBe('욕설을 했어요');
  });

  it('자기 자신·내 단어팩은 400, 없거나 볼 수 없는 대상은 404', async () => {
    const [reporter, owner] = await Promise.all([makeUser(), makeUser()]);
    const reason = 'INAPPROPRIATE_CONTENT';
    expect(
      (await report(reporter, { targetType: 'USER', targetId: reporter.userId, reason })).json()
        .code,
    ).toBe('REPORT_SELF');
    expect(
      (await report(reporter, { targetType: 'USER', targetId: newId(), reason })).json().code,
    ).toBe('REPORT_TARGET_NOT_FOUND');

    const mine = await createPack(reporter);
    expect(
      (await report(reporter, { targetType: 'PACK', targetId: mine.packId, reason })).json().code,
    ).toBe('REPORT_SELF');

    const theirs = await createPack(owner);
    for (const target of [
      { targetType: 'PACK', targetId: theirs.packId },
      { targetType: 'WORD', targetId: theirs.wordId },
    ]) {
      expect((await report(reporter, { ...target, reason })).json().code).toBe(
        'REPORT_TARGET_NOT_FOUND',
      );
    }
    expect((await call(owner, 'POST', `/packs/${theirs.packId}/share`)).statusCode).toBe(200);
    expect(
      (await report(reporter, { targetType: 'PACK', targetId: theirs.packId, reason })).statusCode,
    ).toBe(201);
    expect(
      (await report(reporter, { targetType: 'WORD', targetId: theirs.wordId, reason })).statusCode,
    ).toBe(201);
  });

  it('참여하지 않은 대결을 붙이면 404', async () => {
    const [reporter, target] = await Promise.all([makeUser(), makeUser()]);
    const res = await report(reporter, {
      targetType: 'USER',
      targetId: target.userId,
      reason: 'CHEATING',
      battleId: newId(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('BATTLE_NOT_FOUND');
  });
});
