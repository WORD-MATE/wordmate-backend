import { Controller, Get, HttpStatus, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { AppException } from '../../common/errors/app-exception.js';
import { ZodResponse } from '../../common/zod/decorators.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';

type CheckResult = 'up' | 'down';

const HealthResponse = z.object({
  status: z.literal('ok'),
  checks: z.object({ db: z.literal('up'), valkey: z.literal('up') }),
});
type HealthResponse = z.infer<typeof HealthResponse>;

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  @Get()
  @ZodResponse(HealthResponse)
  async check(): Promise<HealthResponse> {
    const [db, valkey] = await Promise.all([
      probe(() => this.db.execute(sql`select 1`)),
      probe(() => this.valkey.ping()),
    ]);
    const checks = { db, valkey };
    if (db === 'down' || valkey === 'down') {
      throw new AppException(
        'HEALTH_CHECK_FAILED',
        '일부 인프라에 연결할 수 없습니다.',
        HttpStatus.SERVICE_UNAVAILABLE,
        { checks },
      );
    }
    return { status: 'ok', checks: { db: 'up', valkey: 'up' } };
  }
}

const PROBE_TIMEOUT_MS = 2000;

async function probe(fn: () => Promise<unknown>): Promise<CheckResult> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(reject, PROBE_TIMEOUT_MS).unref()),
    ]);
    return 'up';
  } catch {
    return 'down';
  }
}
