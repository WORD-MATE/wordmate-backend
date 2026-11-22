import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import type { RankPeriod, RankScope } from '../../common/enums.js';
import { CommonErrors } from '../../common/errors/app-exception.js';
import { decodeCursor, encodeCursor } from '../../common/pagination.js';
import { kstDate } from '../../common/time/kst.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import {
  friendships,
  rankingSeasons,
  rankingSnapshots,
  type User,
  users,
} from '../../infra/db/schema/index.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { toUserSummary } from '../users/user-summary.js';
import type {
  MyRanking,
  MyRankingQuery,
  RankingEntry,
  RankingPage,
  RankingQuery,
} from './ranking.schemas.js';
import {
  periodKey,
  previousPeriodDate,
  rankKey,
  scopeKeyFor,
  topPercentOf,
  XP_FACTOR,
  xpOfScore,
} from './ranking-keys.js';

export const TOP_LIMIT = 100;
export const CLASS_MIN_PARTICIPANTS = 3;
const CACHE_SECONDS = 5 * 60;
const SCAN_CHUNK = 200;
const OffsetCursor = z.object({ o: z.number().int().min(0) });

type Viewer = Pick<User, 'id' | 'role' | 'grade' | 'classNo' | 'rankingPublic'>;
type CachedTop = { updatedAt: string; available: boolean; entries: RankingEntry[] };
type Standing = { rank: number; xp: number; gapToNext: number | null; total: number };

/** 목록에 보이는 사용자: 활동 중인 학생, 랭킹 공개 */
export const listable = (user: User) =>
  user.role === 'STUDENT' && user.status === 'ACTIVE' && user.rankingPublic;

@Injectable()
export class RankingQueryService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  /** 상위 100명을 5분 동안 캐시한다. 비공개·정지·탈퇴 사용자는 빼고 순위를 매긴다 */
  async list(auth: AuthUser, query: RankingQuery): Promise<RankingPage> {
    const viewer = await this.viewer(auth);
    const offset = query.cursor ? decodeCursor(query.cursor, OffsetCursor).o : 0;
    const top =
      query.scope === 'FRIENDS'
        ? await this.friendsTop(viewer, query.period)
        : await this.cachedTop(viewer, query.period, query.scope);
    const items = top.available ? top.entries.slice(offset, offset + query.size) : [];
    const next = offset + query.size;
    return {
      available: top.available,
      updatedAt: top.updatedAt,
      items,
      nextCursor: top.available && next < top.entries.length ? encodeCursor({ o: next }) : null,
    };
  }

  /** 비공개여도 본인 순위는 공개 사용자 사이에 끼워 계산한다. 목록과 달리 캐시 없이 지금 값으로 */
  async me(auth: AuthUser, query: MyRankingQuery): Promise<MyRanking> {
    const viewer = await this.viewer(auth);
    const empty = {
      rank: null,
      topPercent: null,
      xp: 0,
      gapToNext: null,
      change: null,
      rankingPublic: viewer.rankingPublic,
    };
    const today = kstDate();
    const current = await this.standingOf(viewer, query.period, query.scope, today);
    if (!current) return empty;

    const previousDate = previousPeriodDate(query.period, today);
    const previousRank = previousDate
      ? await this.previousRank(viewer, query.period, query.scope, previousDate)
      : null;
    const inTop = current.rank <= TOP_LIMIT;
    return {
      rank: inTop ? current.rank : null,
      topPercent: inTop ? null : topPercentOf(current.rank, current.total),
      xp: current.xp,
      gapToNext: current.gapToNext,
      change: previousRank === null ? null : previousRank - current.rank,
      rankingPublic: viewer.rankingPublic,
    };
  }

  private async viewer(auth: AuthUser): Promise<Viewer> {
    const [viewer] = await this.db
      .select({
        id: users.id,
        role: users.role,
        grade: users.grade,
        classNo: users.classNo,
        rankingPublic: users.rankingPublic,
      })
      .from(users)
      .where(eq(users.id, auth.userId));
    if (!viewer) throw CommonErrors.unauthorized();
    return viewer;
  }

  /** 교사는 내 학년·반·친구가 없으므로 학교 범위만 볼 수 있다 */
  private keyFor(viewer: Viewer, period: RankPeriod, scope: RankScope, date: string) {
    if (scope === 'FRIENDS') return null;
    if (viewer.role !== 'STUDENT' && scope !== 'SCHOOL') throw CommonErrors.forbidden();
    const scopeKey = scopeKeyFor(scope, viewer);
    return scopeKey ? rankKey(period, date, scopeKey) : null;
  }

  private async cachedTop(
    viewer: Viewer,
    period: RankPeriod,
    scope: Exclude<RankScope, 'FRIENDS'>,
  ): Promise<CachedTop> {
    const key = this.keyFor(viewer, period, scope, kstDate());
    if (!key) return { updatedAt: new Date().toISOString(), available: false, entries: [] };
    const cacheKey = `rank:top:${key}`;
    const cached = await this.valkey.get(cacheKey);
    if (cached) return JSON.parse(cached) as CachedTop;

    const entries: RankingEntry[] = [];
    let participants = 0;
    for (let start = 0; ; start += SCAN_CHUNK) {
      const chunk = await this.zrange(key, start, start + SCAN_CHUNK - 1);
      if (chunk.length === 0) break;
      const people = await this.users(chunk.map(([id]) => id));
      for (const [id, xp] of chunk) {
        const user = people.get(id);
        if (!user || !listable(user) || xp <= 0) continue;
        participants++;
        if (entries.length < TOP_LIMIT) {
          entries.push({ rank: entries.length + 1, user: toUserSummary(user), xp });
        }
      }
      // 반 랭킹은 참여 인원을 끝까지 세야 하지만, 다른 범위는 100명을 채우면 멈춘다
      if (scope !== 'CLASS' && entries.length >= TOP_LIMIT) break;
    }
    const top: CachedTop = {
      updatedAt: new Date().toISOString(),
      available: scope !== 'CLASS' || participants >= CLASS_MIN_PARTICIPANTS,
      entries,
    };
    await this.valkey.set(cacheKey, JSON.stringify(top), 'EX', CACHE_SECONDS);
    return top;
  }

  /** 나 + 친구. 친구 랭킹은 학교 범위 점수로 비교하고, 비공개 친구는 빼되 나는 늘 넣는다 */
  private async friendsTop(viewer: Viewer, period: RankPeriod): Promise<CachedTop> {
    const ranked = await this.friendScores(viewer, period, kstDate());
    return {
      updatedAt: new Date().toISOString(),
      available: true,
      entries: ranked.slice(0, TOP_LIMIT).map(({ user, xp }, i) => ({
        rank: i + 1,
        user: toUserSummary(user),
        xp,
      })),
    };
  }

  private async friendScores(viewer: Viewer, period: RankPeriod, date: string) {
    const ids = [viewer.id, ...(await this.friendIds(viewer.id))];
    const key = rankKey(period, date, 'school');
    const scores = await this.valkey.zmscore(key, ...ids);
    const people = await this.users(ids);
    return ids
      .map((id, i) => ({
        id,
        score: scores[i] === null ? 0 : Number(scores[i]),
        user: people.get(id),
      }))
      .filter((row): row is { id: string; score: number; user: User } =>
        Boolean(row.user && (row.id === viewer.id || listable(row.user))),
      )
      .sort((a, b) => b.score - a.score)
      .map((row) => ({ id: row.id, user: row.user, xp: xpOfScore(row.score) }));
  }

  private async friendIds(userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: friendships.friendId })
      .from(friendships)
      .where(eq(friendships.userId, userId));
    return rows.map((row) => row.id);
  }

  /**
   * 직전 시즌을 마감했으면 그 스냅샷의 순위(마감 시점 기준이라 그 뒤 공개 설정·정지가 바뀌어도 그대로),
   * 아직 마감 전이면 지난 기간 ZSET에서 지금 계산한다. 지난 기간에 XP가 없었으면 null
   */
  private async previousRank(
    viewer: Viewer,
    period: RankPeriod,
    scope: RankScope,
    previousDate: string,
  ): Promise<number | null> {
    const scopeKey = scope === 'FRIENDS' ? null : scopeKeyFor(scope, viewer);
    if (scopeKey && period !== 'ALL') {
      const [snapshot] = await this.db
        .select({ seasonId: rankingSeasons.id, rank: rankingSnapshots.rank })
        .from(rankingSeasons)
        .leftJoin(
          rankingSnapshots,
          and(
            eq(rankingSnapshots.seasonId, rankingSeasons.id),
            eq(rankingSnapshots.scope, scopeKey),
            eq(rankingSnapshots.userId, viewer.id),
          ),
        )
        .where(
          and(
            eq(rankingSeasons.period, period),
            eq(rankingSeasons.periodKey, periodKey(period, previousDate)),
            eq(rankingSeasons.status, 'CONFIRMED'),
          ),
        );
      if (snapshot) return snapshot.rank;
    }
    const standing = await this.standingOf(viewer, period, scope, previousDate);
    return standing?.rank ?? null;
  }

  /** XP가 0이면 null */
  private async standingOf(
    viewer: Viewer,
    period: RankPeriod,
    scope: RankScope,
    date: string,
  ): Promise<Standing | null> {
    if (scope === 'FRIENDS') {
      const ranked = await this.friendScores(viewer, period, date);
      const index = ranked.findIndex((row) => row.id === viewer.id);
      const mine = ranked[index];
      if (!mine || mine.xp <= 0) return null;
      const above = ranked[index - 1];
      return {
        rank: index + 1,
        xp: mine.xp,
        gapToNext: above ? above.xp - mine.xp : null,
        total: ranked.filter((row) => row.xp > 0).length,
      };
    }
    const key = this.keyFor(viewer, period, scope, date);
    if (!key) return null;
    const myScore = await this.valkey.zscore(key, viewer.id);
    const xp = myScore === null ? 0 : xpOfScore(Number(myScore));
    if (xp <= 0) return null;

    // XP가 1 이상인 참여자 전체에서 목록에 보이는 사람만 센다 (나는 비공개여도 포함)
    const all = await this.zrangeByMinXp(key, 1);
    const people = await this.users(all.map(([id]) => id));
    const counted = all.filter(([id]) => {
      const user = people.get(id);
      return id === viewer.id || (user !== undefined && listable(user));
    });
    const index = counted.findIndex(([id]) => id === viewer.id);
    const above = counted[index - 1];
    return {
      rank: index + 1,
      xp,
      gapToNext: above ? above[1] - xp : null,
      total: counted.length,
    };
  }

  private async zrange(key: string, start: number, stop: number): Promise<[string, number][]> {
    const flat = await this.valkey.zrevrange(key, start, stop, 'WITHSCORES');
    return this.pairs(flat);
  }

  private async zrangeByMinXp(key: string, minXp: number): Promise<[string, number][]> {
    const flat = await this.valkey.zrevrangebyscore(
      key,
      '+inf',
      String(minXp * XP_FACTOR),
      'WITHSCORES',
    );
    return this.pairs(flat);
  }

  private pairs(flat: string[]): [string, number][] {
    const result: [string, number][] = [];
    for (let i = 0; i < flat.length; i += 2) {
      result.push([flat[i] as string, xpOfScore(Number(flat[i + 1]))]);
    }
    return result;
  }

  private async users(ids: string[]): Promise<Map<string, User>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.select().from(users).where(inArray(users.id, ids));
    return new Map(rows.map((row) => [row.id, row]));
  }
}
