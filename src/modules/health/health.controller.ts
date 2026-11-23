import { Controller, Get, HttpStatus, Inject, type OnModuleDestroy } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import { SkipClientCheck } from '../../common/client/client.decorators.js';
import { AppException } from '../../common/errors/app-exception.js';
import { withTimeout } from '../../common/with-timeout.js';
import { ZodResponse } from '../../common/zod/decorators.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';

const HealthResponse = z.object({
  status: z.literal('ok'),
  checks: z.object({ db: z.literal('up'), valkey: z.literal('up') }),
});
type HealthResponse = z.infer<typeof HealthResponse>;

const LiveResponse = z.object({ status: z.literal('ok'), uptimeSeconds: z.number() });
type LiveResponse = z.infer<typeof LiveResponse>;

const ReadyCheck = z.object({ status: z.literal('up'), latencyMs: z.number() });
const ReadyResponse = z.object({
  status: z.literal('ok'),
  checks: z.object({ db: ReadyCheck, valkey: ReadyCheck }),
});
type ReadyResponse = z.infer<typeof ReadyResponse>;

interface ProbeResult {
  status: 'up' | 'down';
  latencyMs: number;
}

@Auth('ALL')
@SkipClientCheck()
@Controller('health')
export class HealthController implements OnModuleDestroy {
  private draining = false;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  onModuleDestroy(): void {
    this.draining = true;
  }

  @Get()
  @ApiOperation({
    summary: 'DB·Valkey 연결 확인 (컨테이너 healthcheck·배포 확인용)',
    description: '하나라도 안 되면 503 HEALTH_CHECK_FAILED',
  })
  @ZodResponse(HealthResponse)
  async check(): Promise<HealthResponse> {
    const { db, valkey } = await this.probeAll();
    if (db.status === 'down' || valkey.status === 'down') {
      throw failed({ db: db.status, valkey: valkey.status });
    }
    return { status: 'ok', checks: { db: 'up', valkey: 'up' } };
  }

  @Get('live')
  @ApiOperation({
    summary: '프로세스 생존 확인',
    description: 'DB·Valkey를 보지 않는다. 의존 서비스가 잠깐 느려도 재시작하지 않게 할 때 쓴다',
  })
  @ZodResponse(LiveResponse)
  live(): LiveResponse {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  @Get('ready')
  @ApiOperation({
    summary: '요청을 받을 준비가 됐는지 (DB·Valkey 연결, 종료 중 여부)',
    description: '연결이 안 되면 503 HEALTH_CHECK_FAILED, 종료 중이면 503 SHUTTING_DOWN',
  })
  @ZodResponse(ReadyResponse)
  async ready(): Promise<ReadyResponse> {
    if (this.draining) {
      throw new AppException(
        'SHUTTING_DOWN',
        '서버가 종료 중입니다.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const { db, valkey } = await this.probeAll();
    if (db.status === 'down' || valkey.status === 'down') throw failed({ db, valkey });
    return {
      status: 'ok',
      checks: {
        db: { status: 'up', latencyMs: db.latencyMs },
        valkey: { status: 'up', latencyMs: valkey.latencyMs },
      },
    };
  }

  private async probeAll(): Promise<{ db: ProbeResult; valkey: ProbeResult }> {
    const [db, valkey] = await Promise.all([
      probe(() => this.db.execute(sql`select 1`)),
      probe(() => this.valkey.ping()),
    ]);
    return { db, valkey };
  }
}

// 컨테이너 healthcheck 제한(5초)보다 짧게 끊어야 응답 없음이 아니라 503으로 보인다
const PROBE_TIMEOUT_MS = 2000;

async function probe(fn: () => Promise<unknown>): Promise<ProbeResult> {
  const started = performance.now();
  let status: ProbeResult['status'] = 'up';
  try {
    await withTimeout(fn(), PROBE_TIMEOUT_MS);
  } catch {
    status = 'down';
  }
  return { status, latencyMs: Math.round(performance.now() - started) };
}

const failed = (checks: Record<string, unknown>) =>
  new AppException(
    'HEALTH_CHECK_FAILED',
    '일부 인프라에 연결할 수 없습니다.',
    HttpStatus.SERVICE_UNAVAILABLE,
    { checks },
  );
