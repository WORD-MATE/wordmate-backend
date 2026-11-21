import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';

export const BATTLE_QUEUE = 'battle';
export const BattleJob = { expireRoom: 'expire-room', startBattle: 'start-battle' } as const;

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

  /** 카운트다운이 끝나는 시각에 대결을 시작한다. 취소 뒤 다시 시작할 수 있어 시각을 id에 넣는다 */
  async scheduleStart(roomId: string, at: Date): Promise<void> {
    await this.queue.add(
      BattleJob.startBattle,
      { roomId, countdownEndsAt: at.toISOString() },
      {
        delay: Math.max(0, at.getTime() - Date.now()),
        jobId: `start-battle-${roomId}-${at.getTime()}`,
        attempts: 3,
        backoff: { type: 'fixed', delay: 500 },
        removeOnComplete: true,
        removeOnFail: 100,
      },
    );
  }
}
