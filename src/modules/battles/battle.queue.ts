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
  async scheduleExpiry(roomId: string, at: Date, retry = false): Promise<void> {
    await this.queue
      .add(
        BattleJob.expireRoom,
        { roomId },
        {
          delay: Math.max(0, at.getTime() - Date.now()),
          // 다시 예약할 때는 지금 돌고 있는 작업과 id가 겹치면 무시되므로 다른 id를 쓴다
          jobId: retry ? `expire-room-${roomId}-${Date.now()}` : `expire-room-${roomId}`,
          attempts: 5,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: true,
          removeOnFail: 100,
        },
      )
      .catch((error: unknown) =>
        this.logger.error(`방 만료 예약 실패 (${roomId}): ${String(error)}`),
      );
  }
}
