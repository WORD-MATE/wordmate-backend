import { HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { REACTION } from '../../common/enums.js';
import { AppException } from '../../common/errors/app-exception.js';
import { type Database, DB, type Transaction } from '../../infra/db/db.module.js';
import {
  type BattleRoom,
  battleRoomParticipants,
  battleRooms,
} from '../../infra/db/schema/index.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import {
  type RealtimeContext,
  RealtimeErrors,
  RealtimeService,
} from '../realtime/realtime.service.js';
import { BattleQueue } from './battle.queue.js';
import { RoomErrors, RoomsService } from './rooms.service.js';

export const COUNTDOWN_MS = 3000;
export const MIN_START_PARTICIPANTS = 2;
export const REACTION_INTERVAL_SECONDS = 3;
const LOBBY_STATUSES = ['WAITING', 'COUNTDOWN'] as const;

export const LobbyErrors = {
  notMember: () =>
    new AppException('ROOM_NOT_MEMBER', '이 대결방의 참가자가 아닙니다.', HttpStatus.FORBIDDEN),
  notHost: () => new AppException('ROOM_NOT_HOST', '방장만 할 수 있습니다.', HttpStatus.FORBIDDEN),
  notEnough: () =>
    new AppException(
      'ROOM_NOT_ENOUGH_PARTICIPANTS',
      `${MIN_START_PARTICIPANTS}명 이상 모여야 시작할 수 있습니다.`,
      HttpStatus.CONFLICT,
    ),
  invalidKickTarget: () =>
    new AppException(
      'ROOM_KICK_TARGET_INVALID',
      '강퇴할 수 없는 참가자입니다.',
      HttpStatus.BAD_REQUEST,
    ),
};

const RoomPayload = z.object({ roomId: z.uuid() });
const KickPayload = RoomPayload.extend({ userId: z.uuid() });
const ReactionPayload = RoomPayload.extend({ reaction: z.enum(REACTION) });

type Event = { userIds: string[]; type: string; payload: unknown };

/**
 * 대기실의 실시간 동작. 상태를 바꾸는 메시지는 방 행을 잠근 트랜잭션에서 처리하고,
 * 알림은 커밋한 뒤에 보낸다 (롤백된 변화를 알리지 않게)
 */
@Injectable()
export class LobbyService implements OnModuleInit {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly realtime: RealtimeService,
    private readonly rooms: RoomsService,
    private readonly queue: BattleQueue,
  ) {}

  onModuleInit(): void {
    this.realtime.handle('ROOM_SUBSCRIBE', RoomPayload, (ctx, p) => this.subscribe(ctx, p.roomId));
    this.realtime.handle('ROOM_LEAVE', RoomPayload, (ctx, p) => this.leave(ctx.userId, p.roomId));
    this.realtime.handle('ROOM_KICK', KickPayload, (ctx, p) =>
      this.kick(ctx.userId, p.roomId, p.userId),
    );
    this.realtime.handle('ROOM_START', RoomPayload, (ctx, p) => this.start(ctx.userId, p.roomId));
    this.realtime.handle('REACTION_SEND', ReactionPayload, (ctx, p) =>
      this.react(ctx.userId, p.roomId, p.reaction),
    );
    this.realtime.onUserGone((userId) => this.markDisconnected(userId));
  }

  /** 참가자(교사용 방은 진행자도)만 구독한다. 끊겼다 돌아온 참가자는 다시 CONNECTED */
  async subscribe(ctx: RealtimeContext, roomId: string): Promise<void> {
    const events = await this.db.transaction(async (tx) => {
      const { room, participant } = await this.membership(tx, roomId, ctx.userId);
      if (!participant || participant.state === 'CONNECTED') return [];
      await tx
        .update(battleRoomParticipants)
        .set({ state: 'CONNECTED' })
        .where(this.participantIs(roomId, ctx.userId));
      return [this.toOthers(room, await this.members(tx, room), ctx.userId, 'CONNECTED')];
    });
    ctx.reply('ROOM_STATE', { room: await this.rooms.view(roomId) });
    await this.publish(events);
  }

  /**
   * 방장이 나가면 가장 먼저 들어온 참가자가 방장이 된다. 모두 나가면 방을 닫고,
   * 교사용 방에서 진행자가 나가면 방을 닫는다. 카운트다운 중에 인원이 모자라면 취소한다
   */
  async leave(userId: string, roomId: string): Promise<void> {
    const events = await this.db.transaction(async (tx) => {
      const { room, participant } = await this.membership(tx, roomId, userId);
      this.assertLobby(room);
      const before = await this.members(tx, room);

      if (room.type === 'CLASS' && room.hostUserId === userId) {
        await this.close(tx, room.id);
        return [{ userIds: before, type: 'ROOM_CLOSED', payload: { reason: 'HOST_LEFT' } }];
      }
      if (!participant) throw LobbyErrors.notMember();

      await tx
        .update(battleRoomParticipants)
        .set({ state: 'LEFT', active: false, leftAt: new Date() })
        .where(this.participantIs(roomId, userId));
      const events: Event[] = [
        { userIds: before, type: 'PARTICIPANT_STATE', payload: { roomId, userId, state: 'LEFT' } },
      ];
      const remaining = await this.activeParticipants(tx, roomId);

      if (room.type !== 'CLASS' && remaining.length === 0) {
        await this.close(tx, room.id);
        return events;
      }
      const stillHere = before.filter((id) => id !== userId);
      if (participant.isHost && remaining[0]) {
        const next = remaining[0].userId;
        await tx
          .update(battleRoomParticipants)
          .set({ isHost: true })
          .where(this.participantIs(roomId, next));
        await tx.update(battleRooms).set({ hostUserId: next }).where(eq(battleRooms.id, roomId));
        events.push({ userIds: stillHere, type: 'HOST_CHANGED', payload: { hostUserId: next } });
      }
      if (room.status === 'COUNTDOWN' && remaining.length < MIN_START_PARTICIPANTS) {
        await tx.update(battleRooms).set({ status: 'WAITING' }).where(eq(battleRooms.id, roomId));
        events.push({
          userIds: stillHere,
          type: 'COUNTDOWN_CANCELLED',
          payload: { reason: 'NOT_ENOUGH_PARTICIPANTS' },
        });
      }
      return events;
    });
    await this.publish(events);
  }

  /** 방장이 대기실에서만. 강퇴된 사람에게는 ROOM_CLOSED, 나머지에게는 PARTICIPANT_STATE */
  async kick(userId: string, roomId: string, targetId: string): Promise<void> {
    const events = await this.db.transaction(async (tx) => {
      const { room } = await this.membership(tx, roomId, userId);
      if (room.hostUserId !== userId) throw LobbyErrors.notHost();
      if (room.status !== 'WAITING') throw RoomErrors.alreadyStarted();
      const [target] = await tx
        .select()
        .from(battleRoomParticipants)
        .where(and(this.participantIs(roomId, targetId), eq(battleRoomParticipants.active, true)));
      if (!target || targetId === userId) throw LobbyErrors.invalidKickTarget();
      await tx
        .update(battleRoomParticipants)
        .set({ state: 'KICKED', active: false, leftAt: new Date() })
        .where(this.participantIs(roomId, targetId));
      const remaining = (await this.members(tx, room)).filter((id) => id !== targetId);
      return [
        { userIds: [targetId], type: 'ROOM_CLOSED', payload: { reason: 'KICKED' } },
        {
          userIds: remaining,
          type: 'PARTICIPANT_STATE',
          payload: { roomId, userId: targetId, state: 'KICKED' },
        },
      ];
    });
    await this.publish(events);
  }

  /** 방장만, 참가자 2명 이상. 3초 카운트다운 뒤 지연 작업이 대결을 시작한다 */
  async start(userId: string, roomId: string): Promise<void> {
    const result = await this.db.transaction(async (tx) => {
      const { room } = await this.membership(tx, roomId, userId);
      if (room.hostUserId !== userId) throw LobbyErrors.notHost();
      if (room.status !== 'WAITING') throw RoomErrors.alreadyStarted();
      if ((await this.activeParticipants(tx, roomId)).length < MIN_START_PARTICIPANTS) {
        throw LobbyErrors.notEnough();
      }
      await tx.update(battleRooms).set({ status: 'COUNTDOWN' }).where(eq(battleRooms.id, roomId));
      const startsAt = new Date(Date.now() + COUNTDOWN_MS);
      return { startsAt, members: await this.members(tx, room) };
    });
    try {
      await this.queue.scheduleStart(roomId, result.startsAt);
    } catch (error) {
      // 예약하지 못하면 카운트다운이 끝나지 않으므로 대기실로 되돌린다
      await this.db
        .update(battleRooms)
        .set({ status: 'WAITING' })
        .where(and(eq(battleRooms.id, roomId), eq(battleRooms.status, 'COUNTDOWN')));
      throw error;
    }
    await this.publish([
      {
        userIds: result.members,
        type: 'COUNTDOWN_STARTED',
        payload: { startsAt: result.startsAt.toISOString() },
      },
    ]);
  }

  /**
   * 카운트다운이 끝나면 지연 작업이 부른다. 그사이 취소됐거나 인원이 모자라면 대기실로 돌린다.
   * 문항 진행은 이 뒤에 붙는다
   */
  async begin(roomId: string): Promise<boolean> {
    const outcome = await this.db.transaction(async (tx) => {
      const [room] = await tx
        .select()
        .from(battleRooms)
        .where(eq(battleRooms.id, roomId))
        .for('update');
      if (room?.status !== 'COUNTDOWN') return null;
      const members = await this.members(tx, room);
      if ((await this.activeParticipants(tx, roomId)).length < MIN_START_PARTICIPANTS) {
        await tx.update(battleRooms).set({ status: 'WAITING' }).where(eq(battleRooms.id, roomId));
        return { started: false, members };
      }
      await tx
        .update(battleRooms)
        .set({ status: 'IN_PROGRESS', startedAt: new Date() })
        .where(eq(battleRooms.id, roomId));
      return { started: true, members };
    });
    if (!outcome) return false;
    if (!outcome.started) {
      await this.publish([
        {
          userIds: outcome.members,
          type: 'COUNTDOWN_CANCELLED',
          payload: { reason: 'NOT_ENOUGH_PARTICIPANTS' },
        },
      ]);
      return false;
    }
    await this.publish([
      {
        userIds: outcome.members,
        type: 'ROOM_STATE',
        payload: { room: await this.rooms.view(roomId) },
      },
    ]);
    return true;
  }

  /** 3초에 한 번. 차단 기능이 생기면 받는 사람에서 차단 관계를 뺀다 */
  async react(userId: string, roomId: string, reaction: string): Promise<void> {
    const { room } = await this.membership(this.db, roomId, userId, false);
    const allowed = await this.valkey.set(
      `react:rl:${roomId}:${userId}`,
      '1',
      'EX',
      REACTION_INTERVAL_SECONDS,
      'NX',
    );
    if (!allowed) throw RealtimeErrors.rateLimited();
    const others = (await this.members(this.db, room)).filter((id) => id !== userId);
    await this.publish([
      { userIds: others, type: 'REACTION_RECEIVED', payload: { userId, reaction } },
    ]);
  }

  /** 모든 인스턴스에서 연결이 끊겼으면 대기실의 참가 상태를 DISCONNECTED로 (방에서는 나가지 않는다) */
  async markDisconnected(userId: string): Promise<void> {
    if (await this.realtime.isOnline(userId)) return;
    const rows = await this.db
      .select({ room: battleRooms })
      .from(battleRoomParticipants)
      .innerJoin(battleRooms, eq(battleRooms.id, battleRoomParticipants.roomId))
      .where(
        and(
          eq(battleRoomParticipants.userId, userId),
          eq(battleRoomParticipants.active, true),
          eq(battleRoomParticipants.state, 'CONNECTED'),
          inArray(battleRooms.status, [...LOBBY_STATUSES]),
        ),
      );
    const events: Event[] = [];
    for (const { room } of rows) {
      await this.db
        .update(battleRoomParticipants)
        .set({ state: 'DISCONNECTED' })
        .where(and(this.participantIs(room.id, userId), eq(battleRoomParticipants.active, true)));
      events.push(this.toOthers(room, await this.members(this.db, room), userId, 'DISCONNECTED'));
    }
    await this.publish(events);
  }

  /** 트랜잭션에서는 방 행을 잠근다 (리액션처럼 상태를 바꾸지 않을 때는 lock=false) */
  private async membership(
    executor: Database | Transaction,
    roomId: string,
    userId: string,
    lock = true,
  ) {
    const query = executor.select().from(battleRooms).where(eq(battleRooms.id, roomId));
    const [room] = lock ? await query.for('update') : await query;
    if (!room || room.status === 'EXPIRED' || room.status === 'FINISHED')
      throw RoomErrors.notFound();
    const [participant] = await executor
      .select()
      .from(battleRoomParticipants)
      .where(and(this.participantIs(roomId, userId), eq(battleRoomParticipants.active, true)));
    if (!participant && room.hostUserId !== userId) throw LobbyErrors.notMember();
    return { room, participant: participant ?? null };
  }

  private assertLobby(room: BattleRoom): void {
    if (!(LOBBY_STATUSES as readonly string[]).includes(room.status)) {
      throw RoomErrors.alreadyStarted();
    }
  }

  private participantIs(roomId: string, userId: string) {
    return and(
      eq(battleRoomParticipants.roomId, roomId),
      eq(battleRoomParticipants.userId, userId),
    );
  }

  private activeParticipants(executor: Database | Transaction, roomId: string) {
    return executor
      .select({ userId: battleRoomParticipants.userId })
      .from(battleRoomParticipants)
      .where(
        and(eq(battleRoomParticipants.roomId, roomId), eq(battleRoomParticipants.active, true)),
      )
      .orderBy(asc(battleRoomParticipants.joinedAt));
  }

  /** 알림 받을 사람: 방에 남은 참가자 + 진행자(교사) */
  private async members(executor: Database | Transaction, room: BattleRoom): Promise<string[]> {
    const ids = new Set(
      (await this.activeParticipants(executor, room.id)).map((row) => row.userId),
    );
    if (room.hostUserId) ids.add(room.hostUserId);
    return [...ids];
  }

  private toOthers(room: BattleRoom, members: string[], userId: string, state: string): Event {
    return {
      userIds: members.filter((id) => id !== userId),
      type: 'PARTICIPANT_STATE',
      payload: { roomId: room.id, userId, state },
    };
  }

  private async close(tx: Transaction, roomId: string): Promise<void> {
    await tx.update(battleRooms).set({ status: 'EXPIRED' }).where(eq(battleRooms.id, roomId));
    await tx
      .update(battleRoomParticipants)
      .set({ active: false })
      .where(eq(battleRoomParticipants.roomId, roomId));
  }

  private async publish(events: Event[]): Promise<void> {
    for (const event of events) {
      await this.realtime.sendToUsers(event.userIds, event.type, event.payload).catch(() => {});
    }
  }
}
