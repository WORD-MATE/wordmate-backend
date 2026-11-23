import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  badges,
  classes,
  type NewUser,
  teacherClasses,
  userBadges,
  users,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { AVATAR_IDS } from '../src/modules/users/avatars.js';
import { createTestApp, inject } from './support/create-test-app.js';

describe('프로필 수정·기본 아바타', () => {
  let app: NestFastifyApplication;
  let db: Database;
  const userIds: string[] = [];
  const inactiveBadgeId = newId();
  let firstStudyId: string;
  let firstWinId: string;

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `프로필${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 2 : null,
      classNo: role === 'STUDENT' ? 3 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: false, deviceId: newId() };
  };

  const authHeader = async (user: AuthUser) => ({
    authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}`,
  });

  const patchProfile = async (user: AuthUser, payload: Record<string, unknown>) =>
    inject(app, {
      method: 'PATCH',
      url: '/users/me/profile',
      headers: await authHeader(user),
      payload,
    });

  const give = (userId: string, badgeId: string) =>
    db.insert(userBadges).values({ userId, badgeId, earnedAt: new Date() });

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    const seeded = await db
      .select({ id: badges.id, code: badges.code })
      .from(badges)
      .where(inArray(badges.code, ['FIRST_STUDY', 'FIRST_WIN']));
    firstStudyId = seeded.find((b) => b.code === 'FIRST_STUDY')?.id as string;
    firstWinId = seeded.find((b) => b.code === 'FIRST_WIN')?.id as string;
    await db.insert(badges).values({
      id: inactiveBadgeId,
      code: `PROFILE_TEST_${inactiveBadgeId.slice(-8)}`,
      type: 'ACHIEVEMENT',
      name: '내린 배지',
      description: '테스트용',
      conditionText: '테스트용',
      imageUrl: 'badges/test',
      active: false,
    });
  });

  afterAll(async () => {
    if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
    await db.delete(badges).where(eq(badges.id, inactiveBadgeId));
    await app.close();
  });

  it('기본 아바타 목록은 ID와 이미지 키를 준다', async () => {
    const user = await makeUser();
    const res = await inject(app, {
      method: 'GET',
      url: '/users/avatars',
      headers: await authHeader(user),
    });
    expect(res.statusCode).toBe(200);
    const list = res.json();
    expect(list.map((a: { avatarId: string }) => a.avatarId)).toEqual([...AVATAR_IDS]);
    expect(list[0]).toEqual({ avatarId: 'default', imageUrl: 'avatars/default' });

    expect((await inject(app, { method: 'GET', url: '/users/avatars' })).statusCode).toBe(401);
  });

  it('아바타와 대표 배지를 바꾸고, 생략하면 그대로, null이면 해제한다', async () => {
    const user = await makeUser();
    await give(user.userId, firstStudyId);

    const set = await patchProfile(user, { avatarId: 'cat', representativeBadgeId: firstStudyId });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({
      userId: user.userId,
      avatarId: 'cat',
      representativeBadgeId: firstStudyId,
    });

    const avatarOnly = await patchProfile(user, { avatarId: 'fox' });
    expect(avatarOnly.json()).toMatchObject({
      avatarId: 'fox',
      representativeBadgeId: firstStudyId,
    });

    const badgeCleared = await patchProfile(user, { representativeBadgeId: null });
    expect(badgeCleared.json()).toMatchObject({ avatarId: 'fox', representativeBadgeId: null });

    const avatarReset = await patchProfile(user, { avatarId: null });
    expect(avatarReset.json()).toMatchObject({ avatarId: 'default', representativeBadgeId: null });

    const nothing = await patchProfile(user, {});
    expect(nothing.statusCode).toBe(200);

    const me = await inject(app, {
      method: 'GET',
      url: '/users/me',
      headers: await authHeader(user),
    });
    expect(me.json()).toMatchObject({ avatarId: 'default', representativeBadgeId: null });
  });

  it('없는 아바타는 USER_AVATAR_NOT_FOUND, 바꾸지 않는다', async () => {
    const user = await makeUser({ avatarId: 'dog' });
    await give(user.userId, firstStudyId);
    const res = await patchProfile(user, {
      avatarId: 'unicorn',
      representativeBadgeId: firstStudyId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('USER_AVATAR_NOT_FOUND');
    const [row] = await db.select().from(users).where(eq(users.id, user.userId));
    expect(row).toMatchObject({ avatarId: 'dog', representativeBadgeId: null });
  });

  it('갖지 않았거나 내려간 배지는 USER_BADGE_NOT_OWNED, 형식이 틀리면 INVALID_REQUEST', async () => {
    const user = await makeUser();
    await give(user.userId, firstStudyId);
    await give(user.userId, inactiveBadgeId);

    for (const badgeId of [firstWinId, inactiveBadgeId, newId()]) {
      const res = await patchProfile(user, { avatarId: 'owl', representativeBadgeId: badgeId });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe('USER_BADGE_NOT_OWNED');
    }
    const [row] = await db.select().from(users).where(eq(users.id, user.userId));
    expect(row).toMatchObject({ avatarId: 'default', representativeBadgeId: null });

    const invalid = await patchProfile(user, { representativeBadgeId: 'not-a-uuid' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('INVALID_REQUEST');
  });

  it('교사는 아바타는 바꾸고 대표 배지는 지정할 수 없다', async () => {
    const teacher = await makeUser({ role: 'TEACHER' });
    const [cls] = await db.select().from(classes).limit(1);
    await db
      .insert(teacherClasses)
      .values({ teacherId: teacher.userId, classId: cls?.id as string });
    const avatar = await patchProfile(teacher, { avatarId: 'bear', representativeBadgeId: null });
    expect(avatar.statusCode).toBe(200);
    expect(avatar.json()).toMatchObject({ avatarId: 'bear', representativeBadgeId: null });

    const badge = await patchProfile(teacher, { representativeBadgeId: firstStudyId });
    expect(badge.statusCode).toBe(400);
    expect(badge.json().code).toBe('USER_BADGE_NOT_OWNED');
  });
});
