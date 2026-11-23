import { HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
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
import { blockersAmong } from '../blocks/block-queries.js';
import {
  type RealtimeContext,
  RealtimeErrors,
  RealtimeService,
} from '../realtime/realtime.service.js';
import { BattleQueue } from './battle.queue.js';
import { type LobbyEvent, participantIs, publishEvents, toOthers } from './lobby-events.js';
import { LobbyPresenceService } from './lobby-presence.service.js';
import { PlayService } from './play.service.js';
import { activeParticipants, roomMembers } from './room-members.js';
import { RoomErrors, RoomsService } from './rooms.service.js';

export const COUNTDOWN_MS = 3000;
export const MIN_START_PARTICIPANTS = 2;
export const REACTION_INTERVAL_SECONDS = 3;

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
    private readonly play: PlayService,
    private readonly presence: LobbyPresenceService,
  ) {}

  onModuleInit(): void {
    this.realtime.handle('ROOM_SUBSCRIBE', RoomPayload, (ctx, p) => this.subscribe(ctx, p.roomId));
    this.realtime.handle('ROOM_RESUME', RoomPayload, (ctx, p) => this.subscribe(ctx, p.roomId));
    this.realtime.handle('ROOM_LEAVE', RoomPayload, (ctx, p) => this.leave(ctx.userId, p.roomId));
    this.realtime.handle('ROOM_KICK', KickPayload, (ctx, p) =>
      this.kick(ctx.userId, p.roomId, p.userId),
    );
    this.realtime.handle('ROOM_START', RoomPayload, (ctx, p) => this.start(ctx.userId, p.roomId));
    this.realtime.handle('REACTION_SEND', ReactionPayload, (ctx, p) =>
      this.react(ctx.userId, p.roomId, p.reaction),
    );
    this.realtime.onUserGone((userId) => this.presence.markDisconnected(userId));
  }

  /**
   * 참가자(교사용 방은 진행자도)만 구독한다. 끊겼다 돌아온 참가자는 다시 CONNECTED.
   * ROOM_RESUME도 같다. 진행 중이면 지금 문항(또는 결과)을 이어서 보낸다
   */
  async subscribe(ctx: RealtimeContext, roomId: string): Promise<void> {
    if (await this.replyIfFinished(ctx, roomId)) return;
    const { status, events } = await this.db.transaction(async (tx) => {
      const { room, participant } = await this.membership(tx, roomId, ctx.userId);
      if (!participant || participant.state === 'CONNECTED') {
        return { status: room.status, events: [] };
      }
      await tx
        .update(battleRoomParticipants)
        .set({ state: 'CONNECTED', disconnectedAt: null })
        .where(participantIs(roomId, ctx.userId));
      return {
        status: room.status,
        events: [toOthers(room, await roomMembers(tx, room), ctx.userId, 'CONNECTED')],
      };
    });
    ctx.reply('ROOM_STATE', { room: await this.rooms.view(roomId) });
    if (status === 'IN_PROGRESS') await this.play.resume(ctx, roomId);
    await publishEvents(this.realtime, events);
  }

  /**
   * 방장이 나가면 가장 먼저 들어온 참가자가 방장이 된다. 모두 나가면 방을 닫고,
   * 교사용 방에서 진행자가 나가면 방을 닫는다. 카운트다운 중에 인원이 모자라면 취소한다.
   * 진행 중에도 나갈 수 있다 (나간 사람은 LEFT, 남은 문항은 0점)
   */
  async leave(userId: string, roomId: string): Promise<void> {
    const { status, events } = await this.db.transaction(async (tx) => {
      const { room, participant } = await this.membership(tx, roomId, userId);
      if (room.type === 'CLASS' && room.hostUserId === userId) {
        const before = await roomMembers(tx, room);
        await this.close(tx, room.id);
        return {
          status: room.status,
          events: [{ userIds: before, type: 'ROOM_CLOSED', payload: { reason: 'HOST_LEFT' } }],
        };
      }
      if (!participant) throw LobbyErrors.notMember();
      return { status: room.status, events: await this.leaveIn(tx, room, userId) };
    });
    await publishEvents(this.realtime, events);
    if (status === 'IN_PROGRESS') await this.play.afterLeave(roomId);
  }

  /** 끝난 대결의 참가자(교사용 방 진행자 포함)가 이어 받으려 하면 방 상태와 결과 id를 보낸다 */
  private async replyIfFinished(ctx: RealtimeContext, roomId: string): Promise<boolean> {
    const [room] = await this.db.select().from(battleRooms).where(eq(battleRooms.id, roomId));
    if (room?.status !== 'FINISHED') return false;
    const [participant] = await this.db
      .select({ state: battleRoomParticipants.state })
      .from(battleRoomParticipants)
      .where(participantIs(roomId, ctx.userId));
    const played = participant && participant.state !== 'KICKED';
    if (!played && room.hostUserId !== ctx.userId) return false;
    const view = await this.rooms.view(roomId);
    ctx.reply('ROOM_STATE', { room: view });
    if (view.battleId) ctx.reply('BATTLE_FINISHED', { battleId: view.battleId });
    return true;
  }

  /** 진행 중 끊긴 지 30초가 지나도 돌아오지 않으면 내보낸다 (그사이 돌아왔다 다시 끊겼으면 그 유예를 따른다) */
  async expireGrace(roomId: string, userId: string, disconnectedAt: Date): Promise<void> {
    const events = await this.db.transaction(async (tx) => {
      const [room] = await tx
        .select()
        .from(battleRooms)
        .where(eq(battleRooms.id, roomId))
        .for('update');
      if (room?.status !== 'IN_PROGRESS') return null;
      const [participant] = await tx
        .select()
        .from(battleRoomParticipants)
        .where(and(participantIs(roomId, userId), eq(battleRoomParticipants.active, true)))
        .for('update');
      if (
        participant?.state !== 'DISCONNECTED' ||
        participant.disconnectedAt?.getTime() !== disconnectedAt.getTime()
      ) {
        return null;
      }
      return this.leaveIn(tx, room, userId);
    });
    if (!events) return;
    await publishEvents(this.realtime, events);
    await this.play.afterLeave(roomId);
  }

  private async leaveIn(tx: Transaction, room: BattleRoom, userId: string): Promise<LobbyEvent[]> {
    const roomId = room.id;
    const before = await roomMembers(tx, room);
    await tx
      .update(battleRoomParticipants)
      .set({ state: 'LEFT', active: false, isHost: false, leftAt: new Date() })
      .where(participantIs(roomId, userId));
    const events: LobbyEvent[] = [
      { userIds: before, type: 'PARTICIPANT_STATE', payload: { roomId, userId, state: 'LEFT' } },
    ];
    const remaining = await activeParticipants(tx, roomId);

    const stillHere = before.filter((id) => id !== userId);
    // 진행 중에는 교사용 방이라도 학생이 모두 나가면 닫는다
    if (remaining.length === 0 && (room.type !== 'CLASS' || room.status === 'IN_PROGRESS')) {
      await this.close(tx, room.id);
      // 교사용 방이면 진행자에게 알린다
      events.push({ userIds: stillHere, type: 'ROOM_CLOSED', payload: { reason: 'EMPTY' } });
      return events;
    }
    // 참가자의 is_host가 아니라 방의 방장 기준으로 판단한다 (나갔다 들어온 사람의 옛 표시에 끌려가지 않게)
    if (room.hostUserId === userId && remaining[0]) {
      const next = remaining[0].userId;
      await tx
        .update(battleRoomParticipants)
        .set({ isHost: true })
        .where(participantIs(roomId, next));
      await tx.update(battleRooms).set({ hostUserId: next }).where(eq(battleRooms.id, roomId));
      events.push({ userIds: stillHere, type: 'HOST_CHANGED', payload: { hostUserId: next } });
    }
    if (room.status === 'COUNTDOWN' && remaining.length < MIN_START_PARTICIPANTS) {
      await tx
        .update(battleRooms)
        .set({ status: 'WAITING', countdownEndsAt: null })
        .where(eq(battleRooms.id, roomId));
      events.push({
        userIds: stillHere,
        type: 'COUNTDOWN_CANCELLED',
        payload: { reason: 'NOT_ENOUGH_PARTICIPANTS' },
      });
    }
    return events;
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
        .where(and(participantIs(roomId, targetId), eq(battleRoomParticipants.active, true)));
      if (!target || targetId === userId) throw LobbyErrors.invalidKickTarget();
      await tx
        .update(battleRoomParticipants)
        .set({ state: 'KICKED', active: false, isHost: false, leftAt: new Date() })
        .where(participantIs(roomId, targetId));
      const remaining = (await roomMembers(tx, room)).filter((id) => id !== targetId);
      return [
        { userIds: [targetId], type: 'ROOM_CLOSED', payload: { reason: 'KICKED' } },
        {
          userIds: remaining,
          type: 'PARTICIPANT_STATE',
          payload: { roomId, userId: targetId, state: 'KICKED' },
        },
      ];
    });
    await publishEvents(this.realtime, events);
  }

  /** 방장만, 참가자 2명 이상. 3초 카운트다운 뒤 지연 작업이 대결을 시작한다 */
  async start(userId: string, roomId: string): Promise<void> {
    const result = await this.db.transaction(async (tx) => {
      const { room } = await this.membership(tx, roomId, userId);
      if (room.hostUserId !== userId) throw LobbyErrors.notHost();
      if (room.status !== 'WAITING') throw RoomErrors.alreadyStarted();
      // 만료 시각이 지났으면 곧 닫힐 방이라 시작하지 않는다
      if (room.expiresAt <= new Date()) throw RoomErrors.notFound();
      if ((await activeParticipants(tx, roomId)).length < MIN_START_PARTICIPANTS) {
        throw LobbyErrors.notEnough();
      }
      const startsAt = new Date(Date.now() + COUNTDOWN_MS);
      await tx
        .update(battleRooms)
        .set({ status: 'COUNTDOWN', countdownEndsAt: startsAt })
        .where(eq(battleRooms.id, roomId));
      return { startsAt, members: await roomMembers(tx, room) };
    });
    try {
      await this.queue.scheduleStart(roomId, result.startsAt);
    } catch (error) {
      // 예약하지 못하면 카운트다운이 끝나지 않으므로 대기실로 되돌린다
      await this.db
        .update(battleRooms)
        .set({ status: 'WAITING', countdownEndsAt: null })
        .where(
          and(
            eq(battleRooms.id, roomId),
            eq(battleRooms.status, 'COUNTDOWN'),
            eq(battleRooms.countdownEndsAt, result.startsAt),
          ),
        );
      throw error;
    }
    // 예약하는 사이 취소됐으면 시작 알림이 취소 알림 뒤에 도착하지 않게 보내지 않는다
    const [now] = await this.db
      .select({ status: battleRooms.status, countdownEndsAt: battleRooms.countdownEndsAt })
      .from(battleRooms)
      .where(eq(battleRooms.id, roomId));
    if (
      now?.status !== 'COUNTDOWN' ||
      now.countdownEndsAt?.getTime() !== result.startsAt.getTime()
    ) {
      return;
    }
    await publishEvents(this.realtime, [
      {
        userIds: result.members,
        type: 'COUNTDOWN_STARTED',
        payload: { startsAt: result.startsAt.toISOString() },
      },
    ]);
  }

  /**
   * 카운트다운이 끝나면 지연 작업이 부른다. 그사이 취소됐거나 인원이 모자라면 대기실로 돌린다.
   * 시작한 뒤 알림에서 실패해 작업이 다시 돌면 알림만 다시 보낸다. 문항 진행은 이 뒤에 붙는다
   */
  async begin(roomId: string, countdownEndsAt: Date): Promise<boolean> {
    const outcome = await this.db.transaction(async (tx) => {
      const [room] = await tx
        .select()
        .from(battleRooms)
        .where(eq(battleRooms.id, roomId))
        .for('update');
      // 취소 뒤 다시 시작했다면 예전 카운트다운의 작업이므로 무시한다
      if (!room || room.countdownEndsAt?.getTime() !== countdownEndsAt.getTime()) return null;
      const members = await roomMembers(tx, room);
      if (room.status === 'IN_PROGRESS') {
        return { started: true as const, members, battleId: await this.play.battleIdOf(roomId) };
      }
      if (room.status !== 'COUNTDOWN') return null;
      const cancel = async (reason: string) => {
        await tx
          .update(battleRooms)
          .set({ status: 'WAITING', countdownEndsAt: null })
          .where(eq(battleRooms.id, roomId));
        return { started: false as const, members, reason };
      };
      const players = await activeParticipants(tx, roomId);
      if (players.length < MIN_START_PARTICIPANTS) return cancel('NOT_ENOUGH_PARTICIPANTS');
      // 시작 뒤 단어가 지워져 보기를 만들 수 없으면 시작하지 않는다
      const battleId = await this.play.createBattle(tx, room);
      if (!battleId) return cancel('QUESTIONS_UNAVAILABLE');
      const startedAt = new Date();
      await tx
        .update(battleRooms)
        .set({ status: 'IN_PROGRESS', startedAt })
        .where(eq(battleRooms.id, roomId));
      // 대기실에서 이미 끊겨 있던 참가자도 지금부터 유예를 센다
      const away = players.filter((row) => row.state === 'DISCONNECTED').map((row) => row.userId);
      if (away.length > 0) {
        await tx
          .update(battleRoomParticipants)
          .set({ disconnectedAt: startedAt })
          .where(
            and(
              eq(battleRoomParticipants.roomId, roomId),
              inArray(battleRoomParticipants.userId, away),
            ),
          );
      }
      return { started: true as const, members, battleId };
    });
    if (!outcome) return false;
    if (!outcome.started) {
      await publishEvents(this.realtime, [
        {
          userIds: outcome.members,
          type: 'COUNTDOWN_CANCELLED',
          payload: { reason: outcome.reason },
        },
      ]);
      return false;
    }
    await publishEvents(this.realtime, [
      {
        userIds: outcome.members,
        type: 'ROOM_STATE',
        payload: { room: await this.rooms.view(roomId) },
      },
    ]);
    await this.presence.scheduleGraceForAway(roomId);
    if (outcome.battleId) await this.play.startQuestion(outcome.battleId, 0);
    return true;
  }

  /** 3초에 한 번. 보낸 사람을 차단한 사람에게는 보내지 않는다 */
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
    const others = (await roomMembers(this.db, room)).filter((id) => id !== userId);
    const blockers = await blockersAmong(this.db, userId, others);
    await publishEvents(this.realtime, [
      {
        userIds: others.filter((id) => !blockers.has(id)),
        type: 'REACTION_RECEIVED',
        payload: { userId, reaction },
      },
    ]);
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
      .where(and(participantIs(roomId, userId), eq(battleRoomParticipants.active, true)));
    if (!participant && room.hostUserId !== userId) throw LobbyErrors.notMember();
    return { room, participant: participant ?? null };
  }

  private async close(tx: Transaction, roomId: string): Promise<void> {
    await tx.update(battleRooms).set({ status: 'EXPIRED' }).where(eq(battleRooms.id, roomId));
    await tx
      .update(battleRoomParticipants)
      .set({ active: false })
      .where(eq(battleRoomParticipants.roomId, roomId));
  }
}
