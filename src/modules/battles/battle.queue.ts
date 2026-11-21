import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

export const BATTLE_QUEUE = 'battle';
export const BattleJob = { expireRoom: 'expire-room' } as const;

@Injectable()
export class BattleQueue {
  private readonly logger = new Logger(BattleQueue.name);

  constructor(@InjectQueue(BATTLE_QUEUE) private readonly queue: Queue) {}

  /** 실패해도 방 만들기는 막지 않는다 (조회·참가 때 만료 시각을 보고 닫는다) */
  async scheduleExpiry(roomId: string, at: Date): Promise<void> {
    await this.queue
      .add(
        BattleJob.expireRoom,
        { roomId },
        {
          delay: Math.max(0, at.getTime() - Date.now()),
          jobId: `expire-room-${roomId}`,
          removeOnComplete: true,
          removeOnFail: 100,
        },
      )
      .catch((error: unknown) =>
        this.logger.error(`방 만료 예약 실패 (${roomId}): ${String(error)}`),
      );
  }
}
