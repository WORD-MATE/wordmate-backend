import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { JOB } from '../src/common/enums.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  auditLogs,
  jobRuns,
  type NewUser,
  notifications,
  users,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { JobRunsService } from '../src/modules/jobs/job-runs.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

type JobView = { job: string; lastStatus: string | null; lastTrigger: string | null };

describe('관리자 정기 작업', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let admin: AuthUser;
  const userIds: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `작업${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 1 : null,
      classNo: role === 'STUDENT' ? 1 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const call = async (user: AuthUser, method: 'GET' | 'POST', url: string) =>
    inject(app, {
      method,
      url,
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });

  const jobsOf = async () => (await call(admin, 'GET', '/admin/jobs')).json() as JobView[];

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    admin = await makeUser({ role: 'TEACHER', isAdmin: true });
  });

  afterAll(async () => {
    await db
      .delete(jobRuns)
      .where(
        and(
          inArray(jobRuns.job, ['MORNING_PUBLISH', 'SEASON_CLOSE']),
          eq(jobRuns.trigger, 'MANUAL'),
        ),
      );
    await app.get<Redis>(VALKEY).del('jobs:manual:MORNING_PUBLISH');
    await db.delete(notifications).where(inArray(notifications.userId, userIds));
    await db.delete(auditLogs).where(inArray(auditLogs.actorId, userIds));
    await app.close();
  });

  it('모든 정기 작업을 보여 주고, 직접 실행하면 기록이 남는다', async () => {
    const list = await jobsOf();
    expect(list.map((j) => j.job)).toEqual([...JOB]);

    const res = await call(admin, 'POST', '/admin/jobs/MORNING_PUBLISH/run');
    expect(res.statusCode).toBe(202);
    expect(res.json().job).toBe('MORNING_PUBLISH');
    // 방금 넣은 작업은 다시 넣지 못한다
    expect((await call(admin, 'POST', '/admin/jobs/MORNING_PUBLISH/run')).json().code).toBe(
      'ADMIN_JOB_RUNNING',
    );

    await expect
      .poll(async () => (await jobsOf()).find((j) => j.job === 'MORNING_PUBLISH'), {
        timeout: 10_000,
      })
      .toMatchObject({ lastStatus: 'SUCCEEDED', lastTrigger: 'MANUAL' });
    expect((await call(admin, 'POST', '/admin/jobs/UNKNOWN/run')).statusCode).toBe(400);
  });

  it('시즌 마감이 실패하면 실패로 남기고 관리자에게 알린다', async () => {
    await expect(
      app.get(JobRunsService).track('SEASON_CLOSE', 'MANUAL', async () => {
        throw new Error('테스트 실패');
      }),
    ).rejects.toThrow('테스트 실패');
    const season = (await jobsOf()).find((j) => j.job === 'SEASON_CLOSE');
    expect(season).toMatchObject({ lastStatus: 'FAILED', lastTrigger: 'MANUAL' });
    const alerts = await db
      .select({ body: notifications.body })
      .from(notifications)
      .where(and(eq(notifications.userId, admin.userId), eq(notifications.type, 'ADMIN_ALERT')));
    expect(alerts).toEqual([{ body: 'SEASON_CLOSE: 테스트 실패' }]);
  });

  it('관리자만 쓸 수 있다', async () => {
    const student = await makeUser();
    expect((await call(student, 'GET', '/admin/jobs')).statusCode).toBe(403);
  });
});
