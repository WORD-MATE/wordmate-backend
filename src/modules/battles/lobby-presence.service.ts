import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { type Database, DB } from '../../infra/db/db.module.js';
import { battleRoomParticipants, battleRooms } from '../../infra/db/schema/index.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { BattleQueue } from './battle.queue.js';
import { type LobbyEvent, participantIs, publishEvents, toOthers } from './lobby-events.js';
import { roomMembers } from './room-members.js';

export const DISCONNECT_GRACE_MS = 30 * 1000;
const OPEN_STATUSES = ['WAITING', 'COUNTDOWN', 'IN_PROGRESS'] as const;

/** 대기실 참가자의 연결 끊김과 유예 예약. 유예가 끝나면 LobbyService.expireGrace가 처리한다 */
@Injectable()
export class LobbyPresenceService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly realtime: RealtimeService,
    private readonly queue: BattleQueue,
  ) {}

  /**
   * 모든 인스턴스에서 연결이 끊겼으면 대기실의 참가 상태를 DISCONNECTED로 (방에서는 나가지 않는다).
   * 그사이 다시 접속해 구독했을 수 있으므로 방을 잠근 뒤 접속 상태와 참가 상태를 다시 확인한다
   */
  async markDisconnected(userId: string): Promise<void> {
    if (await this.realtime.isOnline(userId)) return;
    const rows = await this.db
      .select({ roomId: battleRoomParticipants.roomId })
      .from(battleRoomParticipants)
      .innerJoin(battleRooms, eq(battleRooms.id, battleRoomParticipants.roomId))
      .where(
        and(
          eq(battleRoomParticipants.userId, userId),
          eq(battleRoomParticipants.active, true),
          eq(battleRoomParticipants.state, 'CONNECTED'),
          inArray(battleRooms.status, [...OPEN_STATUSES]),
        ),
      );
    const events: LobbyEvent[] = [];
    const graces: { roomId: string; disconnectedAt: Date }[] = [];
    for (const { roomId } of rows) {
      const disconnectedAt = new Date();
      const event = await this.db.transaction(async (tx) => {
        const [room] = await tx
          .select()
          .from(battleRooms)
          .where(eq(battleRooms.id, roomId))
          .for('update');
        if (!room || !(OPEN_STATUSES as readonly string[]).includes(room.status)) return null;
        if (await this.realtime.isOnline(userId)) return null;
        const [result] = await tx
          .update(battleRoomParticipants)
          .set({ state: 'DISCONNECTED', disconnectedAt })
          .where(
            and(
              participantIs(roomId, userId),
              eq(battleRoomParticipants.active, true),
              eq(battleRoomParticipants.state, 'CONNECTED'),
            ),
          );
        if (result.affectedRows === 0) return null;
        if (room.status === 'IN_PROGRESS') graces.push({ roomId, disconnectedAt });
        return toOthers(room, await roomMembers(tx, room), userId, 'DISCONNECTED');
      });
      if (event) events.push(event);
    }
    await publishEvents(this.realtime, events);
    for (const grace of graces) {
      await this.scheduleGrace(grace.roomId, userId, grace.disconnectedAt);
    }
  }

  /** 시작 작업이 다시 돌아도 같은 끊긴 시각이면 작업 id가 같아 한 번만 예약된다 */
  async scheduleGraceForAway(roomId: string): Promise<void> {
    const away = await this.db
      .select({
        userId: battleRoomParticipants.userId,
        disconnectedAt: battleRoomParticipants.disconnectedAt,
      })
      .from(battleRoomParticipants)
      .where(
        and(
          eq(battleRoomParticipants.roomId, roomId),
          eq(battleRoomParticipants.active, true),
          eq(battleRoomParticipants.state, 'DISCONNECTED'),
        ),
      );
    for (const { userId, disconnectedAt } of away) {
      if (disconnectedAt) await this.scheduleGrace(roomId, userId, disconnectedAt);
    }
  }

  /** 예약에 실패하면 그 참가자는 끊긴 채 남는다 (남은 문항은 미응답, 방은 멈춘 방 정리가 닫는다) */
  private async scheduleGrace(roomId: string, userId: string, disconnectedAt: Date): Promise<void> {
    await this.queue
      .scheduleDisconnectGrace(
        roomId,
        userId,
        disconnectedAt,
        new Date(disconnectedAt.getTime() + DISCONNECT_GRACE_MS),
      )
      .catch(() => {});
  }
}
