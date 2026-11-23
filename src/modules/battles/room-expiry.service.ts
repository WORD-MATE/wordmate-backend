import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, lte, or } from 'drizzle-orm';
import { type Database, DB, type Transaction } from '../../infra/db/db.module.js';
import {
  type BattleRoom,
  battleRoomParticipants,
  battleRooms,
} from '../../infra/db/schema/index.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { BattleQueue } from './battle.queue.js';

/** 문항 30개 × (15초 + 결과 2초)보다 넉넉히. 이보다 오래 진행 중이면 멈춘 방으로 보고 닫는다 */
export const MAX_BATTLE_MS = 30 * 60 * 1000;
/** 카운트다운이 끝나고 이만큼 지나도 시작 작업이 안 돌았으면 예약이 유실된 것으로 보고 대기실로 돌린다 */
export const COUNTDOWN_STALL_MS = 30 * 1000;
const EXPIRY_RECHECK_MS = 60 * 1000;

@Injectable()
export class RoomExpiryService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly realtime: RealtimeService,
    private readonly queue: BattleQueue,
  ) {}

  /**
   * 30분 안에 시작하지 않은 방을 닫는다 (지연 작업과 조회 시점 양쪽에서 부른다).
   * 방 상태와 참가자 비우기를 한 트랜잭션으로 처리한다. 따로 하면 그 사이에 실패했을 때
   * 참가자가 끝난 방에 묶여 다른 방에 들어갈 수 없게 된다. 알림은 커밋한 뒤에 보낸다
   */
  async expire(roomId: string): Promise<boolean> {
    const targets = await this.db.transaction(async (tx) => {
      const [room] = await tx
        .select({ hostUserId: battleRooms.hostUserId })
        .from(battleRooms)
        .where(
          and(
            eq(battleRooms.id, roomId),
            eq(battleRooms.status, 'WAITING'),
            lte(battleRooms.expiresAt, new Date()),
          ),
        )
        .for('update');
      if (!room) return null;
      const members = await this.activeMembers(tx, roomId, room.hostUserId);
      await tx.update(battleRooms).set({ status: 'EXPIRED' }).where(eq(battleRooms.id, roomId));
      await tx
        .update(battleRoomParticipants)
        .set({ active: false })
        .where(eq(battleRoomParticipants.roomId, roomId));
      return members;
    });
    if (!targets) return false;
    await this.realtime.sendToUsers(targets, 'ROOM_CLOSED', { reason: 'EXPIRED' }).catch(() => {});
    return true;
  }

  /**
   * 지연 작업용. 서버 시계 차이로 아직 만료 시각 전이면 다시 예약하고,
   * 카운트다운 중이면 취소돼 대기실로 돌아올 수 있으므로 잠시 뒤 다시 확인한다
   */
  async expireOrReschedule(roomId: string): Promise<boolean> {
    if (await this.expire(roomId)) return true;
    const [room] = await this.db
      .select({
        status: battleRooms.status,
        expiresAt: battleRooms.expiresAt,
        countdownEndsAt: battleRooms.countdownEndsAt,
      })
      .from(battleRooms)
      .where(eq(battleRooms.id, roomId));
    const now = Date.now();
    if (room?.status === 'WAITING' && room.expiresAt.getTime() > now) {
      await this.queue.scheduleExpiry(roomId, room.expiresAt, true);
    } else if (room?.status === 'COUNTDOWN') {
      // 시작 작업이 유실돼 멈춘 카운트다운이면 대기실로 돌린 뒤 대기실 방처럼 만료를 처리한다
      const stalledBefore = new Date(now - COUNTDOWN_STALL_MS);
      if (
        room.countdownEndsAt &&
        room.countdownEndsAt <= stalledBefore &&
        (await this.recoverCountdown(roomId, stalledBefore))
      ) {
        return this.expireOrReschedule(roomId);
      }
      await this.queue.scheduleExpiry(roomId, new Date(now + EXPIRY_RECHECK_MS), true);
    }
    return false;
  }

  async expireIfOverdue(room: BattleRoom): Promise<void> {
    if (room.status === 'WAITING' && room.expiresAt <= new Date()) await this.expire(room.id);
  }

  /**
   * 지연 작업이 늦어져도 만료된 방이 사용자를 붙잡지 않게 참가 전에 정리한다.
   * 이미 끝난 방에 활성으로 남은 참가 기록도 풀어 준다
   */
  async releaseExpired(userId: string): Promise<void> {
    const ended = await this.db
      .select({ roomId: battleRoomParticipants.roomId })
      .from(battleRoomParticipants)
      .innerJoin(battleRooms, eq(battleRooms.id, battleRoomParticipants.roomId))
      .where(
        and(
          eq(battleRoomParticipants.userId, userId),
          eq(battleRoomParticipants.active, true),
          inArray(battleRooms.status, ['FINISHED', 'EXPIRED']),
        ),
      );
    if (ended.length > 0) {
      await this.db
        .update(battleRoomParticipants)
        .set({ active: false })
        .where(
          and(
            eq(battleRoomParticipants.userId, userId),
            inArray(
              battleRoomParticipants.roomId,
              ended.map((row) => row.roomId),
            ),
          ),
        );
    }
    const overdue = await this.db
      .select({ id: battleRooms.id })
      .from(battleRoomParticipants)
      .innerJoin(battleRooms, eq(battleRooms.id, battleRoomParticipants.roomId))
      .where(
        and(
          eq(battleRoomParticipants.userId, userId),
          eq(battleRoomParticipants.active, true),
          eq(battleRooms.status, 'WAITING'),
          lte(battleRooms.expiresAt, new Date()),
        ),
      );
    for (const room of overdue) await this.expire(room.id);
    await this.recoverStalled(userId);
  }

  /**
   * 멈춘 방을 풀어 준다. 시작 작업이 유실된 카운트다운은 대기실로 돌리고,
   * 너무 오래 진행 중인 방은 닫는다 (사용자가 다른 방에 들어갈 수 없게 되지 않도록)
   */
  private async recoverStalled(userId: string): Promise<void> {
    const now = Date.now();
    const stalled = await this.db
      .selectDistinct({ id: battleRooms.id, status: battleRooms.status })
      .from(battleRooms)
      .innerJoin(battleRoomParticipants, eq(battleRoomParticipants.roomId, battleRooms.id))
      .where(
        and(
          eq(battleRoomParticipants.userId, userId),
          eq(battleRoomParticipants.active, true),
          or(
            and(
              eq(battleRooms.status, 'COUNTDOWN'),
              lte(battleRooms.countdownEndsAt, new Date(now - COUNTDOWN_STALL_MS)),
            ),
            and(
              eq(battleRooms.status, 'IN_PROGRESS'),
              lte(battleRooms.startedAt, new Date(now - MAX_BATTLE_MS)),
            ),
          ),
        ),
      );
    for (const room of stalled) {
      if (room.status === 'COUNTDOWN') {
        await this.recoverCountdown(room.id, new Date(now - COUNTDOWN_STALL_MS));
      } else {
        await this.closeStaleInProgress(room.id, new Date(now - MAX_BATTLE_MS));
      }
    }
  }

  /** 멈춘 카운트다운을 대기실로 돌리고 방 사람들에게 `COUNTDOWN_CANCELLED { START_FAILED }`를 보낸다 */
  private async recoverCountdown(roomId: string, endedBefore: Date): Promise<boolean> {
    const targets = await this.db.transaction(async (tx) => {
      const [room] = await tx
        .select({ hostUserId: battleRooms.hostUserId })
        .from(battleRooms)
        .where(
          and(
            eq(battleRooms.id, roomId),
            eq(battleRooms.status, 'COUNTDOWN'),
            lte(battleRooms.countdownEndsAt, endedBefore),
          ),
        )
        .for('update');
      if (!room) return null;
      await tx
        .update(battleRooms)
        .set({ status: 'WAITING', countdownEndsAt: null })
        .where(eq(battleRooms.id, roomId));
      return this.activeMembers(tx, roomId, room.hostUserId);
    });
    if (!targets) return false;
    await this.realtime
      .sendToUsers(targets, 'COUNTDOWN_CANCELLED', { reason: 'START_FAILED' })
      .catch(() => {});
    return true;
  }

  private async activeMembers(
    tx: Transaction,
    roomId: string,
    hostUserId: string | null,
  ): Promise<string[]> {
    const active = await tx
      .select({ userId: battleRoomParticipants.userId })
      .from(battleRoomParticipants)
      .where(
        and(eq(battleRoomParticipants.roomId, roomId), eq(battleRoomParticipants.active, true)),
      );
    const ids = new Set(active.map((row) => row.userId));
    if (hostUserId) ids.add(hostUserId);
    return [...ids];
  }

  private async closeStaleInProgress(roomId: string, startedBefore: Date): Promise<void> {
    const targets = await this.db.transaction(async (tx) => {
      const [room] = await tx
        .select({ hostUserId: battleRooms.hostUserId })
        .from(battleRooms)
        .where(
          and(
            eq(battleRooms.id, roomId),
            eq(battleRooms.status, 'IN_PROGRESS'),
            lte(battleRooms.startedAt, startedBefore),
          ),
        )
        .for('update');
      if (!room) return null;
      const active = await tx
        .select({ userId: battleRoomParticipants.userId })
        .from(battleRoomParticipants)
        .where(
          and(eq(battleRoomParticipants.roomId, roomId), eq(battleRoomParticipants.active, true)),
        );
      await tx.update(battleRooms).set({ status: 'EXPIRED' }).where(eq(battleRooms.id, roomId));
      await tx
        .update(battleRoomParticipants)
        .set({ active: false })
        .where(eq(battleRoomParticipants.roomId, roomId));
      const ids = new Set(active.map((row) => row.userId));
      if (room.hostUserId) ids.add(room.hostUserId);
      return [...ids];
    });
    if (targets) {
      await this.realtime
        .sendToUsers(targets, 'ROOM_CLOSED', { reason: 'EXPIRED' })
        .catch(() => {});
    }
  }

  /** 교사용 방은 진행자가 참가자가 아니라 참가자 기준 정리에 걸리지 않으므로 따로 본다 */
  async recoverStalledHostedBy(hostUserId: string): Promise<void> {
    const now = Date.now();
    const stale = await this.db
      .select({ id: battleRooms.id })
      .from(battleRooms)
      .where(
        and(
          eq(battleRooms.hostUserId, hostUserId),
          eq(battleRooms.status, 'IN_PROGRESS'),
          lte(battleRooms.startedAt, new Date(now - MAX_BATTLE_MS)),
        ),
      );
    for (const room of stale) {
      await this.closeStaleInProgress(room.id, new Date(now - MAX_BATTLE_MS));
    }
    const stalledBefore = new Date(now - COUNTDOWN_STALL_MS);
    const stalled = await this.db
      .select({ id: battleRooms.id })
      .from(battleRooms)
      .where(
        and(
          eq(battleRooms.hostUserId, hostUserId),
          eq(battleRooms.status, 'COUNTDOWN'),
          lte(battleRooms.countdownEndsAt, stalledBefore),
        ),
      );
    for (const room of stalled) await this.recoverCountdown(room.id, stalledBefore);
  }

  async expireOverdue(): Promise<void> {
    const overdue = await this.db
      .select({ id: battleRooms.id })
      .from(battleRooms)
      .where(and(eq(battleRooms.status, 'WAITING'), lte(battleRooms.expiresAt, new Date())));
    for (const room of overdue) await this.expire(room.id);
  }
}
