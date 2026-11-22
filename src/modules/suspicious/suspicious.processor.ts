import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { kstDate } from '../../common/time/kst.js';
import { triggerOf } from '../jobs/job-registry.js';
import { JobRunsService } from '../jobs/job-runs.service.js';
import { SuspiciousService } from './suspicious.service.js';

export const SUSPICIOUS_QUEUE = 'suspicious';
const DETECT_SUSPICIOUS = 'detect-suspicious';

/** 매일 04:30(KST)에 전날 활동을 본다. 직접 실행해도 전날 기준 */
@Processor(SUSPICIOUS_QUEUE)
export class SuspiciousProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(SuspiciousProcessor.name);

  constructor(
    @InjectQueue(SUSPICIOUS_QUEUE) private readonly queue: Queue,
    private readonly suspicious: SuspiciousService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  /** Valkey가 내려가 있으면 등록이 연결될 때까지 기다리므로 앱 시작을 막지 않는다 */
  onApplicationBootstrap(): void {
    void this.queue
      .upsertJobScheduler(
        DETECT_SUSPICIOUS,
        { pattern: '30 4 * * *', tz: 'Asia/Seoul' },
        { name: DETECT_SUSPICIOUS, opts: { removeOnComplete: 30, removeOnFail: 30 } },
      )
      .catch((error: unknown) => this.logger.error(`부정 감지 스케줄 등록 실패: ${String(error)}`));
  }

  async process(job: Job) {
    const result = await this.runs.track('SUSPICIOUS_DETECT', triggerOf(job.data), () => {
      const yesterday = Temporal.PlainDate.from(kstDate()).subtract({ days: 1 }).toString();
      return this.suspicious.detect(yesterday);
    });
    this.logger.log(`부정 감지 ${JSON.stringify(result)}`);
    return result;
  }
}
