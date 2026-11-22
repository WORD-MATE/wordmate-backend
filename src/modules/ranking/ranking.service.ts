import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq, gte, max, sql, sum } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { RANK_PERIOD, type RankPeriod } from '../../common/enums.js';
import { kstDate } from '../../common/time/kst.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { users, xpLedger } from '../../infra/db/schema/index.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import {
  encodeScore,
  periodKey,
  RANK_KEY_TTL_SECONDS,
  rankKey,
  type RankMember,
  scopeKeys,
  tiebreakOf,
  XP_FACTOR,
} from './ranking-keys.js';

/**
 * 키마다 기존 XP에 amount를 더하고 도달 시각을 지금으로 바꾼다.
 * Lua 숫자를 그대로 넘기면 %.14g로 바뀌어 자릿수가 잘리므로 %.0f 문자열로 넘긴다
 */
const ADD_XP_SCRIPT = `
local member = ARGV[1]
local amount = tonumber(ARGV[2])
local tiebreak = tonumber(ARGV[3])
local factor = tonumber(ARGV[4])
for i, key in ipairs(KEYS) do
  local score = redis.call('ZSCORE', key, member)
  local xp = 0
  if score then
    local s = tonumber(score)
    xp = (s - math.fmod(s, factor)) / factor
  end
  redis.call('ZADD', key, string.format('%.0f', (xp + amount) * factor + tiebreak), member)
  local ttl = tonumber(ARGV[4 + i])
  if ttl > 0 then redis.call('EXPIRE', key, ttl) end
end
return #KEYS
`;

/** 조정: 0 아래로는 내려가지 않고 0이면 뺀다. 늘어날 때만 도달 시각을 바꾼다 */
const ADJUST_XP_SCRIPT = `
local member = ARGV[1]
local delta = tonumber(ARGV[2])
local tiebreak = tonumber(ARGV[3])
local factor = tonumber(ARGV[4])
for i, key in ipairs(KEYS) do
  local score = redis.call('ZSCORE', key, member)
  local xp, kept = 0, tiebreak
  if score then
    local s = tonumber(score)
    kept = math.fmod(s, factor)
    xp = (s - kept) / factor
  end
  local next = xp + delta
  if next <= 0 then
    redis.call('ZREM', key, member)
  else
    local tb = kept
    if delta > 0 then tb = tiebreak end
    redis.call('ZADD', key, string.format('%.0f', next * factor + tb), member)
    local ttl = tonumber(ARGV[4 + i])
    if ttl > 0 then redis.call('EXPIRE', key, ttl) end
  end
end
return #KEYS
`;

/**
 * 학년·반이 바뀐 사용자의 이번 기간 점수를 옮긴다. 학교 키(KEYS[1])에는 기간 전체 점수가 있으므로
 * 그 점수를 새 범위 키에 그대로 넣고 옛 범위 키에서는 뺀다
 */
const MOVE_SCOPE_SCRIPT = `
local member = ARGV[1]
local removeCount = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
for i = 2, removeCount + 1 do
  redis.call('ZREM', KEYS[i], member)
end
local score = redis.call('ZSCORE', KEYS[1], member)
if not score then return 0 end
for i = removeCount + 2, #KEYS do
  redis.call('ZADD', KEYS[i], score, member)
  if ttl > 0 then redis.call('EXPIRE', KEYS[i], ttl) end
end
return 1
`;

@Injectable()
export class RankingService {
  private readonly logger = new Logger(RankingService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  /**
   * XP 지급 트랜잭션이 커밋된 뒤 호출한다 (롤백된 XP가 랭킹에 남지 않게).
   * Valkey 장애로 실패해도 지급은 이미 끝났으므로 로그만 남기고, 복구 명령으로 원장에서 다시 만든다
   */
  async addXp(userId: string, amount: number, at = new Date()): Promise<void> {
    if (amount <= 0) return;
    try {
      const [member] = await this.db
        .select({ role: users.role, grade: users.grade, classNo: users.classNo })
        .from(users)
        .where(eq(users.id, userId));
      const scopes = member ? scopeKeys(member) : [];
      if (scopes.length === 0) return;
      const date = kstDate(at);
      const keys = RANK_PERIOD.flatMap((period) =>
        scopes.map((scope) => ({ key: rankKey(period, date, scope), period })),
      );
      await this.valkey.eval(
        ADD_XP_SCRIPT,
        keys.length,
        ...keys.map((k) => k.key),
        userId,
        amount,
        tiebreakOf(at),
        XP_FACTOR,
        ...keys.map((k) => RANK_KEY_TTL_SECONDS[k.period] ?? 0),
      );
    } catch (error) {
      this.logger.error(`랭킹 반영 실패 (user ${userId}, +${amount}): ${String(error)}`);
    }
  }

  /** 관리자 XP 조정 (음수 가능). 커밋 뒤 호출하고 실패는 로그만 남긴다 */
  async adjustXp(userId: string, delta: number, at = new Date()): Promise<void> {
    if (delta === 0) return;
    try {
      const [member] = await this.db
        .select({ role: users.role, grade: users.grade, classNo: users.classNo })
        .from(users)
        .where(eq(users.id, userId));
      const scopes = member ? scopeKeys(member) : [];
      if (scopes.length === 0) return;
      const date = kstDate(at);
      const keys = RANK_PERIOD.flatMap((period) =>
        scopes.map((scope) => ({ key: rankKey(period, date, scope), period })),
      );
      await this.valkey.eval(
        ADJUST_XP_SCRIPT,
        keys.length,
        ...keys.map((k) => k.key),
        userId,
        delta,
        tiebreakOf(at),
        XP_FACTOR,
        ...keys.map((k) => RANK_KEY_TTL_SECONDS[k.period] ?? 0),
      );
    } catch (error) {
      this.logger.error(`랭킹 조정 실패 (user ${userId}, ${delta}): ${String(error)}`);
    }
  }

  /** 학년·반이 바뀐 뒤 호출한다. 실패는 로그만 남긴다 (복구 명령으로 다시 만든다) */
  async moveScopes(
    userId: string,
    from: RankMember,
    to: RankMember,
    at = new Date(),
  ): Promise<void> {
    const before = scopeKeys(from);
    const after = scopeKeys(to);
    const removed = before.filter((scope) => !after.includes(scope));
    const added = after.filter((scope) => !before.includes(scope));
    if (removed.length === 0 && added.length === 0) return;
    const date = kstDate(at);
    try {
      for (const period of RANK_PERIOD) {
        const keys = ['school', ...removed, ...added].map((scope) => rankKey(period, date, scope));
        await this.valkey.eval(
          MOVE_SCOPE_SCRIPT,
          keys.length,
          ...keys,
          userId,
          removed.length,
          RANK_KEY_TTL_SECONDS[period] ?? 0,
        );
      }
    } catch (error) {
      this.logger.error(`랭킹 범위 이동 실패 (user ${userId}): ${String(error)}`);
    }
  }

  /**
   * XP 원장에서 이번 주·이번 달·전체 랭킹을 다시 만든다 (Valkey 데이터 유실 복구용).
   * 학년·반은 지금 값으로 넣으므로, 기간 중에 학년·반이 바뀐 사용자는 바뀐 쪽에만 들어간다
   */
  async rebuild(now = new Date()): Promise<Record<RankPeriod, number>> {
    const today = kstDate(now);
    const result = {} as Record<RankPeriod, number>;
    for (const period of RANK_PERIOD) {
      const from =
        period === 'ALL'
          ? null
          : period === 'MONTHLY'
            ? `${periodKey(period, today)}-01`
            : periodKey(period, today);
      const rows = await this.db
        .select({
          userId: xpLedger.userId,
          xp: sum(xpLedger.amount),
          // 실제로 XP가 늘어난 마지막 시각이 그 점수에 도달한 시각이다
          reachedAt: max(sql<Date>`IF(${xpLedger.amount} > 0, ${xpLedger.createdAt}, NULL)`),
          role: users.role,
          grade: users.grade,
          classNo: users.classNo,
        })
        .from(xpLedger)
        .innerJoin(users, eq(users.id, xpLedger.userId))
        .where(from ? gte(xpLedger.date, from) : undefined)
        .groupBy(xpLedger.userId, users.role, users.grade, users.classNo);

      const members = new Map<string, [number, string][]>();
      for (const row of rows) {
        const xp = Number(row.xp ?? 0);
        if (xp <= 0 || !row.reachedAt) continue;
        const score = encodeScore(xp, new Date(row.reachedAt));
        for (const scope of scopeKeys(row)) {
          const key = rankKey(period, today, scope);
          const list = members.get(key) ?? [];
          list.push([score, row.userId]);
          members.set(key, list);
        }
      }

      const prefix = `rank:${period.toLowerCase()}:${periodKey(period, today)}:`;
      const stale = (await this.scan(`${prefix}*`)).filter((key) => !members.has(key));
      const ttl = RANK_KEY_TTL_SECONDS[period];
      const pipeline = this.valkey.multi();
      if (stale.length > 0) pipeline.del(...stale);
      for (const [key, list] of members) {
        pipeline.del(key);
        pipeline.zadd(key, ...list.flatMap(([score, member]) => [score.toFixed(0), member]));
        if (ttl) pipeline.expire(key, ttl);
      }
      await pipeline.exec();
      result[period] = rows.length;
    }
    return result;
  }

  private async scan(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.valkey.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');
    return keys;
  }
}
