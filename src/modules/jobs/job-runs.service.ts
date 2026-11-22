import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { Job, JobTrigger } from '../../common/enums.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { jobRuns, users } from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { NotificationsService } from '../notifications/notifications.service.js';

/** 실패하면 관리자에게 알리는 작업 */
const ALERT_JOBS = new Set<Job>(['SEASON_CLOSE']);

@Injectable()
export class JobRunsService {
  private readonly logger = new Logger(JobRunsService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly notifications: NotificationsService,
  ) {}

  /** 작업 실행을 기록한다. 기록이 실패해도 작업은 돌린다 */
  async track<T>(job: Job, trigger: JobTrigger, run: () => Promise<T>): Promise<T> {
    const previous = ALERT_JOBS.has(job) ? await this.latest(job).catch(() => null) : null;
    const id = newId();
    await this.db
      .insert(jobRuns)
      .values({ id, job, trigger, status: 'RUNNING', startedAt: new Date() })
      .catch((error: unknown) => this.logger.warn(`작업 기록 실패 (${job}): ${String(error)}`));
    try {
      const result = await run();
      await this.finish(id, { status: 'SUCCEEDED', result: result ?? null });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.finish(id, { status: 'FAILED', error: message.slice(0, 1000) });
      // 실패가 이어지는 동안에는 매번 알리지 않는다 (처음 실패할 때만)
      if (ALERT_JOBS.has(job) && previous?.status !== 'FAILED') await this.alert(job, message);
      throw error;
    }
  }

  /** 작업마다 마지막 실행 */
  async latest(job: Job) {
    const [row] = await this.db
      .select()
      .from(jobRuns)
      .where(eq(jobRuns.job, job))
      .orderBy(desc(jobRuns.id))
      .limit(1);
    return row ?? null;
  }

  /** 활동 중인 관리자 모두에게 ADMIN_ALERT */
  async alert(job: Job, message: string): Promise<void> {
    try {
      const admins = await this.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.isAdmin, true), eq(users.status, 'ACTIVE')));
      await this.notifications.notify(
        admins.map((a) => a.id),
        {
          type: 'ADMIN_ALERT',
          title: '정기 작업 실패',
          body: `${job}: ${message}`.slice(0, 200),
          route: '/admin/jobs',
        },
      );
    } catch (error) {
      this.logger.warn(`관리자 알림 실패 (${job}): ${String(error)}`);
    }
  }

  private async finish(
    id: string,
    values: { status: 'SUCCEEDED' | 'FAILED'; result?: unknown; error?: string },
  ): Promise<void> {
    await this.db
      .update(jobRuns)
      .set({ ...values, finishedAt: new Date() })
      .where(eq(jobRuns.id, id))
      .catch((error: unknown) => this.logger.warn(`작업 기록 실패: ${String(error)}`));
  }
}
