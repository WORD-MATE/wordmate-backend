import { getQueueToken } from '@nestjs/bullmq';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Queue } from 'bullmq';
import type { FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { AuditLogService } from '../../common/audit/audit-log.service.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { JOB, type Job } from '../../common/enums.js';
import { AppException } from '../../common/errors/app-exception.js';
import { withTimeout } from '../../common/with-timeout.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { JOB_DEFINITIONS } from '../jobs/job-registry.js';
import { JobRunsService } from '../jobs/job-runs.service.js';

/** 이보다 오래 RUNNING이면 서버가 중간에 꺼진 것으로 보고 다시 실행할 수 있게 한다 */
const STALE_RUN_MS = 60 * 60 * 1000;
/** 두 번 눌러 같은 작업이 겹쳐 들어가지 않게 잠시 막는다 */
const MANUAL_LOCK_SECONDS = 30;
const QUEUE_TIMEOUT_MS = 1000;

export const AdminJobErrors = {
  running: () =>
    new AppException('ADMIN_JOB_RUNNING', '이미 실행 중인 작업입니다.', HttpStatus.CONFLICT),
};

@Injectable()
export class AdminJobsService {
  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly runs: JobRunsService,
    private readonly audit: AuditLogService,
  ) {}

  async list() {
    return Promise.all(
      JOB.map(async (job) => {
        const def = JOB_DEFINITIONS[job];
        const [last, next] = await Promise.all([this.runs.latest(job), this.nextRunAt(job)]);
        return {
          job,
          schedule: def.schedule,
          lastRunAt: last?.startedAt.toISOString() ?? null,
          lastStatus: last?.status ?? null,
          lastTrigger: last?.trigger ?? null,
          lastError: last?.error ?? null,
          nextRunAt: next,
        };
      }),
    );
  }

  /** 큐에 넣고 바로 돌려준다(202). 진행은 목록에서 본다 */
  async run(admin: AuthUser, job: Job, request: FastifyRequest) {
    const last = await this.runs.latest(job);
    if (last?.status === 'RUNNING' && Date.now() - last.startedAt.getTime() < STALE_RUN_MS) {
      throw AdminJobErrors.running();
    }
    const locked = await this.valkey.set(
      `jobs:manual:${job}`,
      admin.userId,
      'EX',
      MANUAL_LOCK_SECONDS,
      'NX',
    );
    if (locked !== 'OK') throw AdminJobErrors.running();
    const def = JOB_DEFINITIONS[job];
    await this.queue(job).add(
      def.name,
      { manual: true },
      { removeOnComplete: 100, removeOnFail: 100 },
    );
    await this.audit.record(
      { actorId: admin.userId, action: 'JOB_RUN', targetType: 'JOB', targetId: job, detail: {} },
      request,
    );
    return { job, queuedAt: new Date().toISOString() };
  }

  private queue(job: Job): Queue {
    return this.moduleRef.get<Queue>(getQueueToken(JOB_DEFINITIONS[job].queue), {
      strict: false,
    });
  }

  /** Valkey가 느려도 목록은 보이게 시간 안에 못 읽으면 null */
  private async nextRunAt(job: Job): Promise<string | null> {
    try {
      const scheduler = await withTimeout(
        this.queue(job).getJobScheduler(JOB_DEFINITIONS[job].name),
        QUEUE_TIMEOUT_MS,
      );
      return scheduler?.next ? new Date(scheduler.next).toISOString() : null;
    } catch {
      return null;
    }
  }
}
