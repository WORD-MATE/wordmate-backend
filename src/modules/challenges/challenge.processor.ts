import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { kstDate } from '../../common/time/kst.js';
import { triggerOf } from '../jobs/job-registry.js';
import { JobRunsService } from '../jobs/job-runs.service.js';
import { ChallengesService } from './challenges.service.js';

export const CHALLENGE_QUEUE = 'challenge';
export const GENERATE_CHALLENGE = 'generate-challenge';
const HOUR_MS = 60 * 60 * 1000;

/** 매일 23:50(KST)에 다음 날 문제를 미리 만든다. 놓쳐도 그날 처음 조회할 때 만든다 */
@Processor(CHALLENGE_QUEUE)
export class ChallengeProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(ChallengeProcessor.name);

  constructor(
    @InjectQueue(CHALLENGE_QUEUE) private readonly queue: Queue,
    private readonly challenges: ChallengesService,
    private readonly runs: JobRunsService,
  ) {
    super();
  }

  /** Valkey가 내려가 있으면 등록이 연결될 때까지 기다리므로 앱 시작을 막지 않는다 */
  onApplicationBootstrap(): void {
    void this.queue
      .upsertJobScheduler(
        GENERATE_CHALLENGE,
        { pattern: '50 23 * * *', tz: 'Asia/Seoul' },
        { name: GENERATE_CHALLENGE, opts: { removeOnComplete: 30, removeOnFail: 30 } },
      )
      .catch((error: unknown) =>
        this.logger.error(`챌린지 생성 스케줄 등록 실패: ${String(error)}`),
      );
  }

  async process(job: Job): Promise<string> {
    return this.runs.track('CHALLENGE_GENERATE', triggerOf(job.data), async () => {
      const date = kstDate(new Date(Date.now() + HOUR_MS));
      await this.challenges.ensure(date);
      return date;
    });
  }
}
