import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BATTLE_QUEUE, BattleJob } from './battle.queue.js';
import { LobbyService } from './lobby.service.js';
import { RoomsService } from './rooms.service.js';

@Processor(BATTLE_QUEUE)
export class BattleProcessor extends WorkerHost {
  constructor(
    private readonly rooms: RoomsService,
    private readonly lobby: LobbyService,
  ) {
    super();
  }

  async process(job: Job<{ roomId: string }>): Promise<boolean> {
    switch (job.name) {
      case BattleJob.expireRoom:
        return this.rooms.expireOrReschedule(job.data.roomId);
      case BattleJob.startBattle:
        return this.lobby.begin(job.data.roomId);
      default:
        throw new Error(`알 수 없는 대결 작업: ${job.name}`);
    }
  }
}
