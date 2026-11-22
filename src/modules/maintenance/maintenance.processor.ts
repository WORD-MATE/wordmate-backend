import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { MaintenanceService } from './maintenance.service.js';

export const MAINTENANCE_QUEUE = 'maintenance';

export const MaintenanceJob = {
  expireSessions: 'expire-study-sessions',
  dailyCleanup: 'daily-cleanup',
} as const;

/**
 * 스케줄은 Valkey에 저장되므로 인스턴스가 여러 개여도 작업은 한 번만 실행된다.
 * upsert라 앱을 다시 띄워도 중복 등록되지 않는다
 */
@Processor(MAINTENANCE_QUEUE)
export class MaintenanceProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    @InjectQueue(MAINTENANCE_QUEUE) private readonly queue: Queue,
    private readonly maintenance: MaintenanceService,
  ) {
    super();
  }

  /**
   * 등록을 기다리지 않는다. Valkey가 내려가 있으면 BullMQ 명령은 연결될 때까지 대기하므로,
   * 기다리면 앱 시작이 멈춘다 (정리 작업은 늦어져도 서비스에 지장이 없다)
   */
  onApplicationBootstrap(): void {
    void this.registerSchedules().catch((error: unknown) =>
      this.logger.error(`정리 작업 스케줄 등록 실패: ${String(error)}`),
    );
  }

  private async registerSchedules(): Promise<void> {
    const template = { opts: { removeOnComplete: 100, removeOnFail: 100 } };
    await this.queue.upsertJobScheduler(
      MaintenanceJob.expireSessions,
      { pattern: '5 * * * *', tz: 'Asia/Seoul' },
      { name: MaintenanceJob.expireSessions, ...template },
    );
    // DataGSM 동기화(04:00)와 겹치지 않게 03:00
    await this.queue.upsertJobScheduler(
      MaintenanceJob.dailyCleanup,
      { pattern: '0 3 * * *', tz: 'Asia/Seoul' },
      { name: MaintenanceJob.dailyCleanup, ...template },
    );
  }

  async process(job: Job): Promise<Record<string, number>> {
    const result = await this.run(job.name);
    this.logger.log(`${job.name} ${JSON.stringify(result)}`);
    return result;
  }

  private async run(name: string): Promise<Record<string, number>> {
    switch (name) {
      case MaintenanceJob.expireSessions:
        return { expiredSessions: await this.maintenance.expireStudySessions() };
      case MaintenanceJob.dailyCleanup:
        return {
          expiredSessions: await this.maintenance.expireStudySessions(),
          purgedSessions: await this.maintenance.purgeEndedSessions(),
          purgedPractices: await this.maintenance.purgePracticeSessions(),
          purgedNotifications: await this.maintenance.purgeNotifications(),
          purgedFavorites: await this.maintenance.purgeDeletedWordFavorites(),
        };
      default:
        // 같은 큐에 작업을 추가하고 여기 처리를 빠뜨리면 조용히 다른 작업이 돌지 않게 실패시킨다
        throw new Error(`알 수 없는 정리 작업: ${name}`);
    }
  }
}
