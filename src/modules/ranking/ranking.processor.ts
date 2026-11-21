import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { type CloseResult, SeasonService } from './season.service.js';

export const RANKING_QUEUE = 'ranking';
export const CLOSE_SEASONS_JOB = 'close-seasons';

@Processor(RANKING_QUEUE)
export class RankingProcessor extends WorkerHost implements OnApplicationBootstrap {
  private readonly logger = new Logger(RankingProcessor.name);

  constructor(
    @InjectQueue(RANKING_QUEUE) private readonly queue: Queue,
    private readonly seasons: SeasonService,
  ) {
    super();
  }

  /** 정리 작업과 같은 이유로 등록을 기다리지 않는다 (Valkey가 없으면 앱 시작이 멈춤) */
  onApplicationBootstrap(): void {
    // 주간은 월요일 00:00, 월간은 1일 00:00에 끝나므로 매시간 돌면서 막 끝난 시즌과 실패한 시즌을 마감한다
    void this.queue
      .upsertJobScheduler(
        CLOSE_SEASONS_JOB,
        { pattern: '10 * * * *', tz: 'Asia/Seoul' },
        { name: CLOSE_SEASONS_JOB, opts: { removeOnComplete: 100, removeOnFail: 100 } },
      )
      .catch((error: unknown) => this.logger.error(`시즌 마감 스케줄 등록 실패: ${String(error)}`));
  }

  async process(job: Job): Promise<CloseResult> {
    if (job.name !== CLOSE_SEASONS_JOB) throw new Error(`알 수 없는 랭킹 작업: ${job.name}`);
    const result = await this.seasons.closeEnded();
    if (result.confirmed.length > 0 || result.failed.length > 0) {
      this.logger.log(`${job.name} ${JSON.stringify(result)}`);
    }
    return result;
  }
}
