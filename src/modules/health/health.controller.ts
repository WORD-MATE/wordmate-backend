import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { type Database, DB } from '../../infra/db/db.module.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';

type CheckResult = 'up' | 'down';

interface HealthResponse {
  status: 'ok' | 'error';
  checks: { db: CheckResult; valkey: CheckResult };
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  @Get()
  async check(): Promise<HealthResponse> {
    const [db, valkey] = await Promise.all([
      probe(() => this.db.execute(sql`select 1`)),
      probe(() => this.valkey.ping()),
    ]);
    const body: HealthResponse = {
      status: db === 'up' && valkey === 'up' ? 'ok' : 'error',
      checks: { db, valkey },
    };
    if (body.status === 'error') {
      throw new HttpException(body, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return body;
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
