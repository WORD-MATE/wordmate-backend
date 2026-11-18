import { Logger } from '@nestjs/common';
import type { ThrottlerStorage } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { withTimeout } from '../with-timeout.js';

const INCREMENT_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
local blocked = redis.call('PTTL', KEYS[2])
if blocked < 0 then blocked = 0 end
if blocked == 0 and hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  blocked = tonumber(ARGV[3])
end
return { hits, ttl, blocked }
`;

type ThrottlerStorageRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

const TIMEOUT_MS = 300;

const toSeconds = (ms: number) => Math.ceil(ms / 1000);

export class ValkeyThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(ValkeyThrottlerStorage.name);

  constructor(private readonly valkey: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `throttle:${throttlerName}:${key}`;
    try {
      const [hits, ttlMs, blockedMs] = (await withTimeout(
        this.valkey.eval(
          INCREMENT_SCRIPT,
          2,
          `${base}:hits`,
          `${base}:blocked`,
          ttl,
          limit,
          blockDuration,
        ),
        TIMEOUT_MS,
      )) as [number, number, number];
      return {
        totalHits: hits,
        timeToExpire: toSeconds(ttlMs),
        isBlocked: blockedMs > 0,
        timeToBlockExpire: toSeconds(blockedMs),
      };
    } catch (error) {
      // Valkey 장애로 모든 요청을 막지 않도록 제한 없이 통과시킨다
      this.logger.warn(`rate limit 확인 실패, 요청을 통과시킵니다: ${String(error)}`);
      return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}
