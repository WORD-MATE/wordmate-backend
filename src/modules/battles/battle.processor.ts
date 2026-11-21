import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BATTLE_QUEUE, BattleJob } from './battle.queue.js';
import { RoomsService } from './rooms.service.js';

@Processor(BATTLE_QUEUE)
export class BattleProcessor extends WorkerHost {
  constructor(private readonly rooms: RoomsService) {
    super();
  }

  async process(job: Job<{ roomId: string }>): Promise<boolean> {
    if (job.name !== BattleJob.expireRoom) throw new Error(`알 수 없는 대결 작업: ${job.name}`);
    return this.rooms.expire(job.data.roomId);
  }
}
