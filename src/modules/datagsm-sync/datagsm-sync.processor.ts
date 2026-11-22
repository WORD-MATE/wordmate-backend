import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { JOB_DEFINITIONS, triggerOf } from '../jobs/job-registry.js';
import { JobRunsService } from '../jobs/job-runs.service.js';
import { DataGsmSyncService } from './datagsm-sync.service.js';

export const DATAGSM_SYNC_QUEUE = JOB_DEFINITIONS.DATAGSM_SYNC.queue;
const DATAGSM_SYNC_JOB = JOB_DEFINITIONS.DATAGSM_SYNC.name;

@Processor(DATAGSM_SYNC_QUEUE)
export class DataGsmSyncProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(DataGsmSyncProcessor.name);

  constructor(
    @InjectQueue(DATAGSM_SYNC_QUEUE) private readonly queue: Queue,
    private readonly sync: DataGsmSyncService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  /** 정리 작업과 같은 이유로 등록을 기다리지 않는다 (Valkey가 없으면 앱 시작이 멈춤) */
  onApplicationBootstrap(): void {
    void this.queue
      .upsertJobScheduler(
        DATAGSM_SYNC_JOB,
        { pattern: '0 4 * * *', tz: 'Asia/Seoul' },
        { name: DATAGSM_SYNC_JOB, opts: { removeOnComplete: 100, removeOnFail: 100 } },
      )
      .catch((error: unknown) =>
        this.logger.error(`학적 동기화 스케줄 등록 실패: ${String(error)}`),
      );
  }

  async process(job: Job) {
    if (job.name !== DATAGSM_SYNC_JOB) throw new Error(`알 수 없는 학적 동기화 작업: ${job.name}`);
    const result = await this.runs.track('DATAGSM_SYNC', triggerOf(job.data), () =>
      this.sync.sync(),
    );
    this.logger.log(`${job.name} ${JSON.stringify(result)}`);
    return result;
  }
}
