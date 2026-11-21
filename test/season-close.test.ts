import { getQueueToken } from '@nestjs/bullmq';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Queue } from 'bullmq';
import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { kstDate } from '../src/common/time/kst.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  type NewUser,
  rankingSeasons,
  rankingSnapshots,
  users,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { CLOSE_SEASONS_JOB, RANKING_QUEUE } from '../src/modules/ranking/ranking.processor.js';
import { RankingService } from '../src/modules/ranking/ranking.service.js';
import { endedSeasons } from '../src/modules/ranking/season.js';
import { SeasonService } from '../src/modules/ranking/season.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLASS = { grade: 3, classNo: 21 };
const SCOPE = 'class:3-21';

describe('시즌 마감', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let ranking: RankingService;
  let seasons: SeasonService;
  const weeks = endedSeasons('WEEKLY', kstDate());
  const lastWeek = weeks[0]?.periodKey as string;
  const threeWeeksAgo = weeks[2]?.periodKey as string;

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    await db
      .insert(users)
      .values({ id: userId, name: '시즌유저', role: 'STUDENT', ...CLASS, ...overrides });
    return { userId, role: 'STUDENT', isAdmin: false, deviceId: newId() };
  };

  const seasonOf = async (periodKey: string) =>
    (
      await db
        .select()
        .from(rankingSeasons)
        .where(and(eq(rankingSeasons.period, 'WEEKLY'), eq(rankingSeasons.periodKey, periodKey)))
    )[0];

  const classSnapshot = async (periodKey: string) => {
    const season = await seasonOf(periodKey);
    return db
      .select({
        userId: rankingSnapshots.userId,
        rank: rankingSnapshots.rank,
        xp: rankingSnapshots.xp,
        listed: rankingSnapshots.listed,
      })
      .from(rankingSnapshots)
      .where(
        and(eq(rankingSnapshots.seasonId, season?.id as string), eq(rankingSnapshots.scope, SCOPE)),
      );
  };

  let a: AuthUser;
  let b: AuthUser;
  let hidden: AuthUser;
  let old: AuthUser;

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    ranking = app.get(RankingService);
    seasons = app.get(SeasonService);
    // 매시간 도는 마감 작업이 먼저 확정했을 수 있으므로 이 테스트가 쓰는 시즌을 비우고 직접 마감한다
    await db.delete(rankingSeasons).where(
      inArray(
        rankingSeasons.periodKey,
        weeks.map((w) => w.periodKey),
      ),
    );

    const lastWeekAt = new Date(Date.now() - 7 * DAY_MS);
    a = await makeUser();
    b = await makeUser();
    hidden = await makeUser({ rankingPublic: false });
    old = await makeUser();
    await ranking.addXp(a.userId, 300, lastWeekAt);
    await ranking.addXp(hidden.userId, 250, lastWeekAt);
    await ranking.addXp(b.userId, 200, lastWeekAt);
    await ranking.addXp(old.userId, 70, new Date(Date.now() - 21 * DAY_MS));
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('앱이 뜨면 매시간 마감 작업이 등록된다', async () => {
    const queue = app.get<Queue>(getQueueToken(RANKING_QUEUE));
    await expect
      .poll(async () => (await queue.getJobSchedulers()).map((s) => s.key), { timeout: 5000 })
      .toContain(CLOSE_SEASONS_JOB);
  });

  it('끝난 시즌을 확정하고, 비공개 사용자도 자기를 끼워 넣은 순위를 남긴다', async () => {
    const result = await seasons.closeEnded();
    expect(result.confirmed).toEqual(
      expect.arrayContaining([`WEEKLY ${lastWeek}`, `WEEKLY ${threeWeeksAgo}`]),
    );
    expect(await seasonOf(lastWeek)).toMatchObject({
      status: 'CONFIRMED',
      attempts: 1,
      lastError: null,
      startsOn: lastWeek,
    });

    const rows = await classSnapshot(lastWeek);
    const byUser = new Map(rows.map((row) => [row.userId, row]));
    expect(byUser.get(a.userId)).toMatchObject({ rank: 1, xp: 300, listed: true });
    expect(byUser.get(hidden.userId)).toMatchObject({ rank: 2, xp: 250, listed: false });
    expect(byUser.get(b.userId)).toMatchObject({ rank: 2, xp: 200, listed: true });
    expect((await classSnapshot(threeWeeksAgo)).map((r) => r.userId)).toEqual([old.userId]);

    // 다시 돌려도 확정한 시즌은 건드리지 않는다
    const again = await seasons.closeEnded();
    expect(again.confirmed).not.toContain(`WEEKLY ${lastWeek}`);
    expect(await classSnapshot(lastWeek)).toHaveLength(3);
  });

  it('마감에 실패하면 FAILED로 남기고 다음 실행에서 다시 시도한다', async () => {
    await db.delete(rankingSeasons).where(eq(rankingSeasons.periodKey, threeWeeksAgo));
    vi.spyOn(
      seasons as unknown as { snapshotRows: () => Promise<unknown> },
      'snapshotRows',
    ).mockRejectedValueOnce(new Error('valkey down'));

    expect((await seasons.closeEnded()).failed).toEqual([`WEEKLY ${threeWeeksAgo}`]);
    expect(await seasonOf(threeWeeksAgo)).toMatchObject({
      status: 'FAILED',
      attempts: 1,
      lastError: expect.stringContaining('valkey down'),
    });

    expect((await seasons.closeEnded()).confirmed).toEqual([`WEEKLY ${threeWeeksAgo}`]);
    expect(await seasonOf(threeWeeksAgo)).toMatchObject({
      status: 'CONFIRMED',
      attempts: 2,
      lastError: null,
    });
  });

  it('내 순위 변동은 확정된 스냅샷 기준 (마감 뒤 지난 기간 점수가 바뀌어도 그대로)', async () => {
    await ranking.addXp(b.userId, 50);
    await ranking.addXp(a.userId, 10);
    const me = async () =>
      (
        await inject(app, {
          method: 'GET',
          url: '/ranking/me?scope=CLASS',
          headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(a)}` },
        })
      ).json();
    expect(await me()).toMatchObject({ rank: 2, change: -1 });

    await ranking.addXp(b.userId, 1000, new Date(Date.now() - 7 * DAY_MS));
    expect(await me()).toMatchObject({ rank: 2, change: -1 });
  });
});
