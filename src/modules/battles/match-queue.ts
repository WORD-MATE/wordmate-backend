import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { VALKEY } from '../../infra/valkey/valkey.module.js';

/** 대기 시간. 지나면 MATCH_TIMEOUT */
export const MATCH_TIMEOUT_MS = 60 * 1000;
/** 성사 결과를 취소 요청에 알려 주려고 남겨 두는 시간 */
const FOUND_TTL_SECONDS = 120;
/** 위·아래로 이만큼만 보고 가장 가까운 상대를 고른다 (만료된 대기자는 보면서 지운다) */
const CANDIDATES = 20;

const QUEUE_KEY = 'mm:queue';
const QUEUED_KEY = 'mm:queued';
const FOUND_PREFIX = 'mm:found:';
const PENDING = 'PENDING';

/**
 * 대기열에 넣거나, 누적 XP가 가장 가까운 대기자와 바로 짝짓는다. 같은 차이면 먼저 기다린 사람.
 * 대기열에서 빼기와 성사를 한 스크립트에서 해서 취소와 성사가 겹쳐도 먼저 도착한 쪽만 이긴다
 */
const ENQUEUE_SCRIPT = `
local queue, queued = KEYS[1], KEYS[2]
local user, xp, now, timeout = ARGV[1], tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local prefix, ttl, limit = ARGV[5], ARGV[6], tonumber(ARGV[7])
local blocked = {}
for i = 8, #ARGV do blocked[ARGV[i]] = true end
-- 방을 만드는 중인 성사가 있으면 그 결과를 기다린다 (두 번 누르거나 두 기기에서 요청한 경우)
if redis.call('GET', prefix .. user) == '${PENDING}' then return {'ALREADY'} end
if redis.call('ZSCORE', queue, user) then
  -- 만료 작업이 유실돼 남은 자기 대기는 지우고 새로 줄 선다
  local mine = tonumber(redis.call('HGET', queued, user) or '0')
  if mine + timeout > now then return {'ALREADY'} end
  redis.call('ZREM', queue, user)
  redis.call('HDEL', queued, user)
end
local best, bestGap, bestAt
local function consider(list)
  for i = 1, #list, 2 do
    local id, score = list[i], tonumber(list[i + 1])
    if id ~= user and not blocked[id] then
      local at = tonumber(redis.call('HGET', queued, id) or '0')
      if at + timeout <= now then
        redis.call('ZREM', queue, id)
        redis.call('HDEL', queued, id)
      else
        local gap = math.abs(score - xp)
        if not best or gap < bestGap or (gap == bestGap and at < bestAt) then
          best, bestGap, bestAt = id, gap, at
        end
      end
    end
  end
end
consider(redis.call('ZRANGEBYSCORE', queue, xp, '+inf', 'WITHSCORES', 'LIMIT', 0, limit))
consider(redis.call('ZREVRANGEBYSCORE', queue, xp, '-inf', 'WITHSCORES', 'LIMIT', 0, limit))
if best then
  redis.call('ZREM', queue, best)
  redis.call('HDEL', queued, best)
  redis.call('SET', prefix .. user, '${PENDING}', 'EX', ttl)
  redis.call('SET', prefix .. best, '${PENDING}', 'EX', ttl)
  return {'MATCHED', best, tostring(bestAt)}
end
redis.call('ZADD', queue, xp, user)
redis.call('HSET', queued, user, now)
redis.call('DEL', prefix .. user)
return {'QUEUED'}
`;

/** 대기 중이면 빼고 CANCELLED, 이미 성사됐으면 그 결과(또는 방을 만드는 중이면 PENDING), 아니면 NONE */
const CANCEL_SCRIPT = `
if redis.call('ZREM', KEYS[1], ARGV[1]) == 1 then
  redis.call('HDEL', KEYS[2], ARGV[1])
  return 'CANCELLED'
end
return redis.call('GET', KEYS[3]) or 'NONE'
`;

/** 그 대기(queuedAt)가 아직 남아 있을 때만 뺀다 (다시 줄을 섰으면 새 대기는 건드리지 않는다) */
const EXPIRE_SCRIPT = `
if redis.call('HGET', KEYS[2], ARGV[1]) == ARGV[2] then
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('HDEL', KEYS[2], ARGV[1])
  return 1
end
return 0
`;

export type EnqueueResult =
  | { kind: 'ALREADY' }
  | { kind: 'QUEUED' }
  | { kind: 'MATCHED'; opponentId: string; opponentQueuedAt: number };

export type CancelResult =
  | { kind: 'CANCELLED' }
  | { kind: 'NONE' }
  | { kind: 'PENDING' }
  | { kind: 'FOUND'; roomId: string; inviteCode: string };

/** 빠른 매칭 대기열 (Valkey). 여러 서버가 같은 대기열을 본다 */
@Injectable()
export class MatchQueue {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async enqueue(
    userId: string,
    xp: number,
    now: number,
    excluded: string[],
  ): Promise<EnqueueResult> {
    const result = (await this.valkey.eval(
      ENQUEUE_SCRIPT,
      2,
      QUEUE_KEY,
      QUEUED_KEY,
      userId,
      xp,
      now,
      MATCH_TIMEOUT_MS,
      FOUND_PREFIX,
      FOUND_TTL_SECONDS,
      CANDIDATES,
      ...excluded,
    )) as string[];
    if (result[0] === 'ALREADY') return { kind: 'ALREADY' };
    if (result[0] === 'MATCHED') {
      return {
        kind: 'MATCHED',
        opponentId: result[1] as string,
        opponentQueuedAt: Number(result[2]),
      };
    }
    return { kind: 'QUEUED' };
  }

  async cancel(userId: string): Promise<CancelResult> {
    const result = (await this.valkey.eval(
      CANCEL_SCRIPT,
      3,
      QUEUE_KEY,
      QUEUED_KEY,
      FOUND_PREFIX + userId,
      userId,
    )) as string;
    if (result === 'CANCELLED' || result === 'NONE' || result === PENDING) {
      return { kind: result };
    }
    const found = JSON.parse(result) as { roomId: string; inviteCode: string };
    return { kind: 'FOUND', ...found };
  }

  async expire(userId: string, queuedAt: number): Promise<boolean> {
    const removed = await this.valkey.eval(
      EXPIRE_SCRIPT,
      2,
      QUEUE_KEY,
      QUEUED_KEY,
      userId,
      String(queuedAt),
    );
    return removed === 1;
  }

  /** 연결이 끊겼거나 직접 방을 만들거나 들어가면 조용히 뺀다 */
  async remove(userId: string): Promise<void> {
    await this.valkey.multi().zrem(QUEUE_KEY, userId).hdel(QUEUED_KEY, userId).exec();
  }

  /** 방을 만들지 못했을 때 원래 대기 시각 그대로 다시 줄 세운다 */
  async requeue(userId: string, xp: number, queuedAt: number): Promise<void> {
    await this.valkey
      .multi()
      .zadd(QUEUE_KEY, xp, userId)
      .hset(QUEUED_KEY, userId, queuedAt)
      .del(FOUND_PREFIX + userId)
      .exec();
  }

  async found(userIds: string[], room: { roomId: string; inviteCode: string }): Promise<void> {
    const tx = this.valkey.multi();
    for (const userId of userIds) {
      tx.set(FOUND_PREFIX + userId, JSON.stringify(room), 'EX', FOUND_TTL_SECONDS);
    }
    await tx.exec();
  }

  async clearFound(userIds: string[]): Promise<void> {
    await this.valkey.del(...userIds.map((userId) => FOUND_PREFIX + userId));
  }
}
