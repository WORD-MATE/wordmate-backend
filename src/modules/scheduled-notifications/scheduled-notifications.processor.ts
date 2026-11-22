import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { ScheduledNotificationsService } from './scheduled-notifications.service.js';

export const SCHEDULED_NOTIFICATIONS_QUEUE = 'scheduled-notifications';

/** 작업 이름 → KST cron */
export const SCHEDULED_NOTIFICATION_JOBS = {
  'study-reminder': '* * * * *',
  'morning-publish': '0 6 * * *',
  'morning-sentence': '0 7 * * *',
  'rank-weekly-result': '0 8 * * 1',
  'rank-drop': '0 20 * * *',
} as const;
type JobName = keyof typeof SCHEDULED_NOTIFICATION_JOBS;

@Processor(SCHEDULED_NOTIFICATIONS_QUEUE)
export class ScheduledNotificationsProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(ScheduledNotificationsProcessor.name);

  constructor(
    @InjectQueue(SCHEDULED_NOTIFICATIONS_QUEUE) private readonly queue: Queue,
    private readonly scheduled: ScheduledNotificationsService,
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
    const runs: Record<JobName, () => Promise<number>> = {
      'study-reminder': () => this.scheduled.studyReminders(),
      'morning-publish': () => this.scheduled.publishMorning(),
      'morning-sentence': () => this.scheduled.morningSentence(),
      'rank-weekly-result': () => this.scheduled.weeklyRankResult(),
      'rank-drop': () => this.scheduled.rankDrops(),
    };
    const run = runs[job.name as JobName];
    if (!run) throw new Error(`알 수 없는 예약 알림 작업: ${job.name}`);
    const count = await run();
    if (count > 0 && job.name !== 'study-reminder') this.logger.log(`${job.name} ${count}`);
    return count;
  }
}
