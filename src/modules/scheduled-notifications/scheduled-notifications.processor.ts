import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { jobOf, triggerOf } from '../jobs/job-registry.js';
import { JobRunsService } from '../jobs/job-runs.service.js';
import { ScheduledNotificationsService } from './scheduled-notifications.service.js';

export const SCHEDULED_NOTIFICATIONS_QUEUE = 'scheduled-notifications';

/** 작업 이름 → KST cron */
export const SCHEDULED_NOTIFICATION_JOBS = {
  'study-reminder': '* * * * *',
  'morning-publish': '0 6 * * *',
  'morning-sentence': '0 7 * * *',
  'rank-weekly-result': '0 8-12 * * 1',
  'rank-drop': '0 20 * * *',
} as const;
type JobName = keyof typeof SCHEDULED_NOTIFICATION_JOBS;

@Processor(SCHEDULED_NOTIFICATIONS_QUEUE)
export class ScheduledNotificationsProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduledNotificationsProcessor.name);

  constructor(
    @InjectQueue(SCHEDULED_NOTIFICATIONS_QUEUE) private readonly queue: Queue,
    private readonly scheduled: ScheduledNotificationsService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  /** 정리 작업과 같은 이유로 등록을 기다리지 않는다 (Valkey가 없으면 앱 시작이 멈춤) */
  onApplicationBootstrap(): void {
    for (const [name, pattern] of Object.entries(SCHEDULED_NOTIFICATION_JOBS)) {
      void this.queue
        .upsertJobScheduler(
          name,
          { pattern, tz: 'Asia/Seoul' },
          { name, opts: { removeOnComplete: 100, removeOnFail: 100 } },
        )
        .catch((error: unknown) =>
          this.logger.error(`예약 알림 스케줄 등록 실패 (${name}): ${String(error)}`),
        );
    }
  }

  async process(job: Job): Promise<number> {
    // 늦게 처리되거나(재시작·밀림) 시계가 조금 어긋나도 예정된 시각 기준으로 보낸다
    const at = new Date(job.timestamp + (job.opts.delay ?? 0));
    const runs: Record<JobName, () => Promise<number>> = {
      'study-reminder': () => this.scheduled.studyReminders(at),
      'morning-publish': () => this.scheduled.publishMorning(at),
      'morning-sentence': () => this.scheduled.morningSentence(at),
      'rank-weekly-result': () => this.scheduled.weeklyRankResult(at),
      'rank-drop': () => this.scheduled.rankDrops(at),
    };
    const run = runs[job.name as JobName];
    if (!run) throw new Error(`알 수 없는 예약 알림 작업: ${job.name}`);
    const name = jobOf(SCHEDULED_NOTIFICATIONS_QUEUE, job.name);
    const count = name ? await this.runs.track(name, triggerOf(job.data), run) : await run();
    if (count > 0 && job.name !== 'study-reminder') this.logger.log(`${job.name} ${count}`);
    return count;
  }
}
