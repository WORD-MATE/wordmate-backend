import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { type DeliverJob, PUSH_QUEUE, PushService } from './push.service.js';

/** 기기마다 따로 보내므로 동시에 여러 개를 처리한다 */
@Processor(PUSH_QUEUE, { concurrency: 10 })
export class PushProcessor extends WorkerHost {
  constructor(private readonly push: PushService) {
    super();
  }

  async process(job: Job<DeliverJob>): Promise<string> {
    return this.push.deliver(job.data);
  }
}
