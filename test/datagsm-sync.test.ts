import { randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import { RANK_PERIOD } from '../src/common/enums.js';
import { kstDate } from '../src/common/time/kst.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  auditLogs,
  classes,
  devices,
  jobRuns,
  type NewUser,
  notifications,
  users,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import {
  DataGsmClient,
  type DataGsmProfile,
  type DataGsmStudent,
} from '../src/modules/auth/datagsm/datagsm.client.js';
import { DataGsmSyncService } from '../src/modules/datagsm-sync/datagsm-sync.service.js';
import { JobRunsService } from '../src/modules/jobs/job-runs.service.js';
import { rankKey } from '../src/modules/ranking/ranking-keys.js';
import { createTestApp, inject } from './support/create-test-app.js';
import { TEST_REDIRECT_URI } from './support/test-env.js';

// 다른 테스트의 반·랭킹 키와 겹치지 않는 학년
const OLD_GRADE = 7;
const NEW_GRADE = 8;

describe('DataGSM 학적 동기화', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let valkey: Redis;
  let listStudents: () => Promise<DataGsmStudent[] | null> = async () => [];
  let profile: DataGsmProfile | null = null;
  const userIds: string[] = [];
  const tag = randomUUID().slice(0, 8);

  const fakeDataGsm = {
    exchangeCode: async () => 'at',
    getProfile: async () => profile,
    listStudents: () => listStudents(),
  };

  const makeUser = async (overrides: Partial<NewUser> = {}) => {
    const id = newId();
    userIds.push(id);
    await db.insert(users).values({
      id,
      name: `동기화${id.slice(-4)}`,
      role: 'STUDENT',
      grade: OLD_GRADE,
      classNo: 1,
      number: 1,
      studentNumber: `${OLD_GRADE}101`,
      ...overrides,
    });
    return id;
  };

  const userOf = async (id: string) => {
    const [row] = await db.select().from(users).where(eq(users.id, id));
    return row;
  };

  const enrolled = (
    studentId: string,
    overrides: Partial<DataGsmStudent> = {},
  ): DataGsmStudent => ({
    studentId,
    email: `${studentId}@gsm.hs.kr`,
    name: '김학생',
    studentNumber: `${NEW_GRADE}301`,
    grade: NEW_GRADE,
    classNo: 3,
    number: 1,
    inactive: false,
    ...overrides,
  });

  const graduated = (studentId: string): DataGsmStudent =>
    enrolled(studentId, {
      studentNumber: null,
      grade: null,
      classNo: null,
      number: null,
      inactive: true,
    });

  const scopes = ['school', `grade:${OLD_GRADE}`, `class:${OLD_GRADE}-1`, `grade:${NEW_GRADE}`];
  const allScopes = [...scopes, `class:${NEW_GRADE}-3`];
  const keysOf = (scope: string) => RANK_PERIOD.map((p) => rankKey(p, kstDate(), scope));

  const cleanClasses = () =>
    db.delete(classes).where(inArray(classes.grade, [OLD_GRADE, NEW_GRADE]));

  beforeAll(async () => {
    app = await createTestApp({ overrides: [[DataGsmClient, fakeDataGsm]] });
    db = app.get(DB);
    valkey = app.get<Redis>(VALKEY);
    await cleanClasses();
  });

  afterAll(async () => {
    const pipeline = valkey.multi();
    for (const scope of allScopes) for (const key of keysOf(scope)) pipeline.zrem(key, ...userIds);
    await pipeline.exec();
    await valkey.del('jobs:manual:DATAGSM_SYNC');
    await db.delete(jobRuns).where(eq(jobRuns.job, 'DATAGSM_SYNC'));
    await db.delete(notifications).where(inArray(notifications.userId, userIds));
    await db.delete(auditLogs).where(inArray(auditLogs.actorId, userIds));
    await db.delete(users).where(inArray(users.id, userIds));
    await cleanClasses();
    await app.close();
  });

  it('학년·반 변경, 졸업 휴면, 재학 복귀를 반영하고 랭킹 범위를 옮긴다', async () => {
    const moved = await makeUser({ datagsmStudentId: `${tag}-moved` });
    const byEmail = await makeUser({ email: `${tag}-grad@gsm.hs.kr` });
    const back = await makeUser({ datagsmStudentId: `${tag}-back`, status: 'INACTIVE' });
    const suspended = await makeUser({ datagsmStudentId: `${tag}-susp`, status: 'SUSPENDED' });
    const missing = await makeUser({ datagsmStudentId: `${tag}-missing` });
    const teacher = await makeUser({
      role: 'TEACHER',
      email: `${tag}-teacher@gsm.hs.kr`,
      grade: null,
      classNo: null,
      number: null,
      studentNumber: null,
    });
    // 같은 이메일의 계정이 둘이면 누구인지 알 수 없어 맞추지 않는다
    const dupA = await makeUser({ email: `${tag}-dup@gsm.hs.kr` });
    const dupB = await makeUser({ email: `${tag}-dup@gsm.hs.kr` });
    await db.insert(devices).values({ userId: byEmail, platform: 'IOS', lastUsedAt: new Date() });

    // 이번 기간 점수: 학교·학년·반 키에 같은 점수가 있다
    for (const scope of scopes.slice(0, 3)) {
      for (const key of keysOf(scope)) await valkey.zadd(key, '12345', moved);
    }

    listStudents = async () => [
      enrolled(`${tag}-moved`),
      graduated(`${tag}-grad`),
      enrolled(`${tag}-back`, { grade: OLD_GRADE, classNo: 1, studentNumber: `${OLD_GRADE}101` }),
      graduated(`${tag}-susp`),
      enrolled(`${tag}-teacher`),
      enrolled(`${tag}-nobody`, { grade: OLD_GRADE, classNo: 2 }),
      enrolled(`${tag}-dup`),
    ];

    const result = await app.get(DataGsmSyncService).sync();
    expect(result).toEqual({
      fetched: 7,
      matched: 4,
      updated: 4,
      deactivated: 1,
      reactivated: 1,
      classesCreated: 3,
      skipped: 0,
      failed: 0,
    });

    expect(await userOf(moved)).toMatchObject({
      status: 'ACTIVE',
      grade: NEW_GRADE,
      classNo: 3,
      number: 1,
      studentNumber: `${NEW_GRADE}301`,
      name: '김학생',
    });
    expect(await userOf(byEmail)).toMatchObject({
      status: 'INACTIVE',
      grade: OLD_GRADE,
      classNo: 1,
      datagsmStudentId: `${tag}-grad`,
    });
    const [device] = await db.select().from(devices).where(eq(devices.userId, byEmail));
    expect(device?.revokedAt).not.toBeNull();
    expect((await userOf(back))?.status).toBe('ACTIVE');
    expect((await userOf(suspended))?.status).toBe('SUSPENDED');
    expect(await userOf(missing)).toMatchObject({ status: 'ACTIVE', grade: OLD_GRADE });
    expect(await userOf(teacher)).toMatchObject({ role: 'TEACHER', grade: null });
    for (const id of [dupA, dupB]) {
      expect(await userOf(id)).toMatchObject({ grade: OLD_GRADE, datagsmStudentId: null });
    }

    const created = await db
      .select({ grade: classes.grade, classNo: classes.classNo })
      .from(classes)
      .where(inArray(classes.grade, [OLD_GRADE, NEW_GRADE]));
    expect(created).toEqual(
      expect.arrayContaining([
        { grade: NEW_GRADE, classNo: 3 },
        { grade: OLD_GRADE, classNo: 1 },
      ]),
    );

    for (const [scope, expected] of [
      ['school', '12345'],
      [`grade:${OLD_GRADE}`, null],
      [`class:${OLD_GRADE}-1`, null],
      [`grade:${NEW_GRADE}`, '12345'],
      [`class:${NEW_GRADE}-3`, '12345'],
    ] as const) {
      for (const key of keysOf(scope)) expect(await valkey.zscore(key, moved)).toBe(expected);
    }

    // 다시 돌려도 바뀌는 것이 없다
    expect(await app.get(DataGsmSyncService).sync()).toMatchObject({
      matched: 4,
      updated: 0,
      deactivated: 0,
      reactivated: 0,
      classesCreated: 0,
    });
  });

  it('마지막 활동 관리자인 학생은 졸업해도 다른 관리자가 생길 때까지 휴면 처리하지 않는다', async () => {
    const others = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.isAdmin, true), eq(users.status, 'ACTIVE')));
    const otherIds = others.map((row) => row.id);
    if (otherIds.length > 0) {
      await db.update(users).set({ isAdmin: false }).where(inArray(users.id, otherIds));
    }
    try {
      const last = await makeUser({ isAdmin: true, datagsmStudentId: `${tag}-last-admin` });
      listStudents = async () => [graduated(`${tag}-last-admin`)];
      await app.get(DataGsmSyncService).sync();
      expect((await userOf(last))?.status).toBe('ACTIVE');

      await makeUser({
        role: 'TEACHER',
        isAdmin: true,
        grade: null,
        classNo: null,
        number: null,
        studentNumber: null,
      });
      await app.get(DataGsmSyncService).sync();
      expect((await userOf(last))?.status).toBe('INACTIVE');
    } finally {
      if (otherIds.length > 0) {
        await db.update(users).set({ isAdmin: true }).where(inArray(users.id, otherIds));
      }
    }
  });

  it('로그인으로 학년·반이 바뀌어도 랭킹 범위를 옮기고, 다른 계정에 붙은 학생 ID를 가져온다', async () => {
    const datagsmId = `${tag}-login`;
    const loginUser = await makeUser({ datagsmId });
    const wrongOwner = await makeUser({ datagsmStudentId: `${tag}-login-sid` });
    for (const scope of scopes.slice(0, 3)) {
      for (const key of keysOf(scope)) await valkey.zadd(key, '777', loginUser);
    }
    profile = {
      datagsmId,
      datagsmStudentId: `${tag}-login-sid`,
      email: `${datagsmId}@gsm.hs.kr`,
      role: 'STUDENT',
      name: '김학생',
      studentNumber: `${NEW_GRADE}302`,
      grade: NEW_GRADE,
      classNo: 3,
      number: 2,
      inactive: false,
      pending: false,
    };

    const res = await inject(app, {
      method: 'POST',
      url: '/auth/datagsm',
      remoteAddress: '10.127.0.1',
      headers: { 'x-client-platform': 'IOS' },
      payload: { code: 'auth-code', codeVerifier: 'v'.repeat(43), redirectUri: TEST_REDIRECT_URI },
    });
    expect(res.statusCode).toBe(200);

    expect(await userOf(loginUser)).toMatchObject({
      grade: NEW_GRADE,
      classNo: 3,
      datagsmStudentId: `${tag}-login-sid`,
    });
    expect((await userOf(wrongOwner))?.datagsmStudentId).toBeNull();
    for (const [scope, expected] of [
      [`class:${OLD_GRADE}-1`, null],
      [`class:${NEW_GRADE}-3`, '777'],
    ] as const) {
      for (const key of keysOf(scope)) expect(await valkey.zscore(key, loginUser)).toBe(expected);
    }
  });

  it('API 키가 없으면 건너뛰고, 관리자가 직접 실행할 수 있다', async () => {
    listStudents = async () => null;
    const admin = await makeUser({
      role: 'TEACHER',
      isAdmin: true,
      grade: null,
      classNo: null,
      number: null,
      studentNumber: null,
    });
    const token = await app
      .get(AccessTokenService)
      .sign({ userId: admin, role: 'TEACHER', isAdmin: true, deviceId: newId() });
    const res = await inject(app, {
      method: 'POST',
      url: '/admin/jobs/DATAGSM_SYNC/run',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(202);

    await expect
      .poll(
        async () => {
          const [run] = await db
            .select()
            .from(jobRuns)
            .where(and(eq(jobRuns.job, 'DATAGSM_SYNC'), eq(jobRuns.trigger, 'MANUAL')))
            .orderBy(desc(jobRuns.id))
            .limit(1);
          return run;
        },
        { timeout: 10_000 },
      )
      .toMatchObject({ status: 'SUCCEEDED', result: { disabled: true } });
  });

  it('DataGSM 요청이 실패하면 실패로 남기고 관리자에게 알린다', async () => {
    const admin = await makeUser({
      role: 'TEACHER',
      isAdmin: true,
      grade: null,
      classNo: null,
      number: null,
      studentNumber: null,
    });
    listStudents = async () => {
      throw new Error('DataGSM 학생 목록 응답 HTTP 401');
    };
    await expect(
      app
        .get(JobRunsService)
        .track('DATAGSM_SYNC', 'MANUAL', () => app.get(DataGsmSyncService).sync()),
    ).rejects.toThrow('HTTP 401');

    const alerts = await db
      .select({ body: notifications.body })
      .from(notifications)
      .where(and(eq(notifications.userId, admin), eq(notifications.type, 'ADMIN_ALERT')));
    expect(alerts).toEqual([{ body: 'DATAGSM_SYNC: DataGSM 학생 목록 응답 HTTP 401' }]);
  });
});
