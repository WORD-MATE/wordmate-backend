import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { BATTLE_QUEUE, BattleJob } from './battle.queue.js';
import { LobbyService } from './lobby.service.js';
import { PlayService } from './play.service.js';
import { RoomsService } from './rooms.service.js';

type BattleJobData = {
  roomId?: string;
  battleId?: string;
  userId?: string;
  idx?: number;
  countdownEndsAt?: string;
  disconnectedAt?: string;
};

// 방마다 문항 작업이 몰리므로 여러 개를 동시에 처리한다 (판정은 받은 시각 기준이라 작업이 늦어도 점수는 그대로)
@Processor(BATTLE_QUEUE, { concurrency: 20 })
export class BattleProcessor extends WorkerHost {
  constructor(
    private readonly rooms: RoomsService,
    private readonly lobby: LobbyService,
    private readonly play: PlayService,
  ) {
    super();
  }

  async process(job: Job<BattleJobData>): Promise<unknown> {
    switch (job.name) {
      case BattleJob.expireRoom:
        return this.rooms.expireOrReschedule(job.data.roomId as string);
      case BattleJob.startBattle:
        return this.lobby.begin(job.data.roomId as string, new Date(job.data.countdownEndsAt ?? 0));
      case BattleJob.startQuestion:
        return this.play.startQuestion(job.data.battleId as string, job.data.idx as number);
      case BattleJob.endQuestion:
        return this.play.endQuestion(job.data.battleId as string, job.data.idx as number, true);
      case BattleJob.disconnectGrace:
        return this.lobby.expireGrace(
          job.data.roomId as string,
          job.data.userId as string,
          new Date(job.data.disconnectedAt ?? 0),
        );
      default:
        throw new Error(`알 수 없는 대결 작업: ${job.name}`);
    }
  }
}
