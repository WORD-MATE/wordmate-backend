import { randomInt } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException, CommonErrors } from '../../common/errors/app-exception.js';
import { KeyedSerializer } from '../../common/keyed-serializer.js';
import type { Env } from '../../config/env.js';
import { type Database, DB, type Transaction } from '../../infra/db/db.module.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import {
  type BattleRoom,
  battleResults,
  battleRoomParticipants,
  battleRooms,
  battles,
  classes,
  type Pack,
  teacherClasses,
  users,
} from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { blockedEitherWay } from '../blocks/block-queries.js';
import { ClassErrors } from '../classes/classes.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PacksService } from '../packs/packs.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { toUserSummary } from '../users/user-summary.js';
import { BattleQueue } from './battle.queue.js';
import { type CreateRoom, INVITE_CODE_PATTERN, type Room } from './battle.schemas.js';
import { BattleErrors } from './battle-results.service.js';
import { MatchQueue } from './match-queue.js';
import { RoomExpiryService } from './room-expiry.service.js';

type Rematch = { pack: Pack; battleId: string };

export const ROOM_TTL_MS = 30 * 60 * 1000;
export const MIN_BATTLE_WORDS = 10;
export const JOIN_FAIL_LIMIT = 5;
export const JOIN_FAIL_WINDOW_SECONDS = 60;
const CODE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const ACTIVE_CODE_INDEX = 'battle_rooms_active_code_uq';
const ACTIVE_USER_INDEX = 'battle_room_participants_active_user_uq';
const ACTIVE_STATUSES = ['WAITING', 'COUNTDOWN', 'IN_PROGRESS'] as const;

export const RoomErrors = {
  packTooFewWords: () =>
    new AppException(
      'BATTLE_PACK_TOO_FEW_WORDS',
      `대결은 단어가 ${MIN_BATTLE_WORDS}개 이상인 단어팩으로만 할 수 있습니다.`,
      HttpStatus.BAD_REQUEST,
    ),
  alreadyJoined: (inviteCode: string | null) =>
    new AppException(
      'ROOM_ALREADY_JOINED',
      '이미 참여 중인 대결방이 있습니다.',
      HttpStatus.CONFLICT,
      { inviteCode },
    ),
  invalidCode: () =>
    new AppException(
      'ROOM_INVITE_CODE_INVALID',
      '초대 코드는 영문 대문자·숫자 6자리입니다.',
      HttpStatus.BAD_REQUEST,
    ),
  notFound: () =>
    new AppException('ROOM_NOT_FOUND', '대결방을 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
  classOnly: () =>
    new AppException(
      'ROOM_CLASS_ONLY',
      '이 반 학생만 들어갈 수 있는 방입니다.',
      HttpStatus.FORBIDDEN,
    ),
  kicked: () =>
    new AppException('ROOM_KICKED', '강퇴된 방에는 다시 들어갈 수 없습니다.', HttpStatus.FORBIDDEN),
  alreadyStarted: () =>
    new AppException('ROOM_ALREADY_STARTED', '이미 시작한 대결입니다.', HttpStatus.CONFLICT),
  full: () => new AppException('ROOM_FULL', '대결방이 가득 찼습니다.', HttpStatus.CONFLICT),
  codeUnavailable: () =>
    new AppException(
      'ROOM_CODE_UNAVAILABLE',
      '초대 코드를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.',
      HttpStatus.SERVICE_UNAVAILABLE,
    ),
  attemptsExceeded: () =>
    new AppException(
      'ROOM_CODE_ATTEMPTS_EXCEEDED',
      '초대 코드를 여러 번 잘못 입력했습니다. 1분 뒤에 다시 시도해 주세요.',
      HttpStatus.TOO_MANY_REQUESTS,
    ),
};

const generateCode = () =>
  Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
const joinFailKey = (userId: string) => `room:join-fail:${userId}`;

@Injectable()
export class RoomsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly packs: PacksService,
    private readonly realtime: RealtimeService,
    private readonly queue: BattleQueue,
    private readonly config: ConfigService<Env, true>,
    private readonly matchQueue: MatchQueue,
    private readonly notifications: NotificationsService,
    private readonly expiry: RoomExpiryService,
  ) {}

  private readonly joinQueue = new KeyedSerializer();
  private readonly logger = new Logger(RoomsService.name);

  /** 만든 사람이 방장이자 첫 참가자 */
  async create(user: AuthUser, body: CreateRoom, rematch?: Rematch): Promise<Room> {
    const pack = rematch?.pack ?? (await this.packs.findVisible(user, body.packId));
    if (pack.wordCount < MIN_BATTLE_WORDS) throw RoomErrors.packTooFewWords();
    await this.expiry.releaseExpired(user.userId);
    const roomId = await this.insertRoom(body, pack, {
      type: 'NORMAL',
      hostUserId: user.userId,
      classId: null,
      hostParticipates: true,
      sourceBattleId: rematch?.battleId ?? null,
    });
    await this.leaveMatchQueue(user.userId);
    return this.view(roomId);
  }

  /** 빠른 매칭으로 짝지은 두 사람의 방. 먼저 기다린 사람이 방장 */
  async createQuickMatch(
    hostUserId: string,
    guestUserId: string,
    pack: Pack,
    body: CreateRoom,
  ): Promise<Room> {
    await this.expiry.releaseExpired(hostUserId);
    await this.expiry.releaseExpired(guestUserId);
    const roomId = await this.insertRoom(body, pack, {
      type: 'QUICK_MATCH',
      hostUserId,
      classId: null,
      hostParticipates: true,
      guests: [guestUserId],
      sourceBattleId: null,
    });
    await this.leaveMatchQueue(hostUserId);
    await this.leaveMatchQueue(guestUserId);
    return this.view(roomId);
  }

  /** 지금 들어가 있는 방 (끝난 방은 참가가 풀려 있어 나오지 않는다) */
  async activeRoomOf(userId: string): Promise<{ roomId: string; inviteCode: string } | null> {
    const [row] = await this.db
      .select({ roomId: battleRooms.id, inviteCode: battleRooms.inviteCode })
      .from(battleRoomParticipants)
      .innerJoin(battleRooms, eq(battleRooms.id, battleRoomParticipants.roomId))
      .where(
        and(eq(battleRoomParticipants.userId, userId), eq(battleRoomParticipants.active, true)),
      );
    return row ?? null;
  }

  /** 다른 방에 있으면 409 ROOM_ALREADY_JOINED (끝났거나 만료된 방은 먼저 풀어 준다) */
  async assertFree(userId: string): Promise<void> {
    await this.expiry.releaseExpired(userId);
    const code = await this.activeCodeOf(userId);
    if (code) throw RoomErrors.alreadyJoined(code);
  }

  /**
   * 같은 설정으로 새 방. 요청한 사람이 방장이고, 교사용 방은 그 교사만 (교사용 반 방으로).
   * 다른 사람의 내 단어팩으로 한 대결도 같은 팩으로 다시 할 수 있다 (팩이 지워졌으면 404)
   */
  async rematch(user: AuthUser, battleId: string): Promise<Room> {
    const [row] = await this.db
      .select({ room: battleRooms, phase: battles.phase })
      .from(battles)
      .innerJoin(battleRooms, eq(battleRooms.id, battles.roomId))
      .where(eq(battles.id, battleId));
    if (row?.phase !== 'FINISHED') throw BattleErrors.notFound();
    const { room } = row;
    const body: CreateRoom = {
      packId: room.packId,
      questionType: room.questionType as CreateRoom['questionType'],
      questionCount: room.questionCount as CreateRoom['questionCount'],
      timeLimitSec: room.timeLimitSec as CreateRoom['timeLimitSec'],
      maxParticipants: room.maxParticipants,
    };
    if (room.type === 'CLASS') {
      if (room.hostUserId !== user.userId || !room.classId) {
        throw CommonErrors.forbidden('교사용 방은 진행한 교사만 다시 할 수 있습니다.');
      }
      const pack = await this.packs.findById(room.packId);
      const created = await this.createForClass(user, room.classId, body, { pack, battleId });
      await this.inviteRematch(user, battleId, created);
      return created;
    }
    const [played] = await this.db
      .select({ userId: battleResults.userId })
      .from(battleResults)
      .where(and(eq(battleResults.battleId, battleId), eq(battleResults.userId, user.userId)));
    if (!played) throw CommonErrors.forbidden('참가하지 않은 대결입니다.');
    if (user.role !== 'STUDENT') throw CommonErrors.forbidden();
    const pack = await this.packs.findById(room.packId);
    const created = await this.create(user, body, { pack, battleId });
    await this.inviteRematch(user, battleId, created);
    return created;
  }

  /** 지난 대결의 다른 참가자를 새 대기실로 초대한다 (차단 관계는 빼고, 실패해도 방은 그대로) */
  private async inviteRematch(user: AuthUser, battleId: string, room: Room): Promise<void> {
    try {
      const players = await this.db
        .select({ userId: battleResults.userId })
        .from(battleResults)
        .where(eq(battleResults.battleId, battleId));
      const blocked = new Set(await blockedEitherWay(this.db, user.userId));
      const invitees = players
        .map((p) => p.userId)
        .filter((id) => id !== user.userId && !blocked.has(id));
      if (invitees.length === 0) return;
      const [host] = await this.db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, user.userId));
      await this.notifications.notify(invitees, {
        type: 'BATTLE_INVITE',
        title: '다시 대결해요',
        body: `${host?.name ?? ''}님이 같은 설정으로 다시 대결하자고 해요.`,
        route: `/battles/rooms/${room.inviteCode}`,
      });
    } catch (error) {
      this.logger.warn(`다시 하기 초대 실패 (${battleId}): ${String(error)}`);
    }
  }

  /** 교사는 진행자라 참가자 목록·인원에 들어가지 않는다. 진행 중인 반 방은 교사당 하나 */
  async createForClass(
    user: AuthUser,
    classId: string,
    body: CreateRoom,
    rematch?: Rematch,
  ): Promise<Room> {
    const [owned] = await this.db
      .select({ classId: teacherClasses.classId })
      .from(teacherClasses)
      .where(and(eq(teacherClasses.teacherId, user.userId), eq(teacherClasses.classId, classId)));
    if (!owned) throw ClassErrors.notAssigned();
    const pack = rematch?.pack ?? (await this.packs.findVisible(user, body.packId));
    if (pack.wordCount < MIN_BATTLE_WORDS) throw RoomErrors.packTooFewWords();
    await this.expiry.expireOverdue();
    await this.expiry.recoverStalledHostedBy(user.userId);
    const roomId = await this.insertRoom(body, pack, {
      type: 'CLASS',
      hostUserId: user.userId,
      classId,
      hostParticipates: false,
      sourceBattleId: rematch?.battleId ?? null,
      // 교사 행을 잠가 동시에 두 번 만들어도 진행 중인 반 방이 하나만 되게 한다
      beforeInsert: async (tx) => {
        await tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.id, user.userId))
          .for('update');
        const [hosting] = await tx
          .select({ inviteCode: battleRooms.inviteCode })
          .from(battleRooms)
          .where(
            and(
              eq(battleRooms.hostUserId, user.userId),
              inArray(battleRooms.status, [...ACTIVE_STATUSES]),
            ),
          );
        if (hosting) throw RoomErrors.alreadyJoined(hosting.inviteCode);
      },
    });
    return this.view(roomId);
  }

  /** 조회도 코드를 찔러보는 데 쓸 수 있으므로 참가와 같은 연속 실패 횟수를 센다 */
  async get(user: AuthUser, inviteCode: string): Promise<Room> {
    if (!INVITE_CODE_PATTERN.test(inviteCode)) {
      await this.countFailure(user.userId);
      throw RoomErrors.invalidCode();
    }
    const room = await this.findByCode(inviteCode);
    if (!room) {
      await this.countFailure(user.userId);
      throw RoomErrors.notFound();
    }
    await this.expiry.expireIfOverdue(room);
    return this.view(room.id);
  }

  async isCodeBlocked(userId: string): Promise<boolean> {
    const fails = await this.valkey.get(joinFailKey(userId)).catch(() => null);
    return Number(fails ?? 0) >= JOIN_FAIL_LIMIT;
  }

  /**
   * 코드를 잘못 넣은 것(형식·없는 방·끝난 방)만 연속 실패로 세고, 참가에 성공해야 다시 센다.
   * 방을 잠가 정원 확인과 참가를 한 번에 처리하고, 다른 방에 이미 있으면 활성 참가자 유니크 제약으로 막는다
   */
  async join(user: AuthUser, inviteCode: string): Promise<Room> {
    if (!INVITE_CODE_PATTERN.test(inviteCode)) {
      await this.countFailure(user.userId);
      throw RoomErrors.invalidCode();
    }
    const found = await this.findByCode(inviteCode);
    if (!found) {
      await this.countFailure(user.userId);
      throw RoomErrors.notFound();
    }
    await this.expiry.expireIfOverdue(found);
    await this.expiry.releaseExpired(user.userId);

    // 반 소속 조회는 잠그기 전에 한다 (잠금을 쥐는 시간을 줄인다). 판정은 예전 순서대로 잠금 안에서
    // 없는 방·이미 참가·강퇴·시작 확인 뒤에 해야 끝난 반 방의 코드도 404로 세어 코드 찔러보기를 막는다
    const member = found.type !== 'CLASS' || (await this.inClass(found.classId, user.userId));
    let joined = false;
    try {
      // 같은 방 참가는 서버 안에서 먼저 줄을 세워, 방 잠금을 기다리는 동안 DB 연결을 붙잡지 않게 한다
      joined = await this.joinQueue.run(found.id, () =>
        this.db.transaction((tx) => this.takeSeat(tx, found.id, user, member)),
      );
    } catch (error) {
      if (isDuplicateKeyError(error, ACTIVE_USER_INDEX)) {
        throw RoomErrors.alreadyJoined(await this.activeCodeOf(user.userId));
      }
      if (error instanceof AppException && error.code === 'ROOM_NOT_FOUND') {
        await this.countFailure(user.userId);
      }
      throw error;
    }
    await this.valkey.del(joinFailKey(user.userId)).catch(() => {});

    const room = await this.view(found.id);
    if (joined) {
      const participant = room.participants.find((p) => p.user.userId === user.userId);
      await this.notify(room, 'PARTICIPANT_JOINED', { participant }, user.userId);
    }
    await this.leaveMatchQueue(user.userId);
    return room;
  }

  /** 방을 잠가 정원·상태를 확인한 뒤 참가 기록을 만든다. 이미 참가 중이면 false */
  private async takeSeat(
    tx: Transaction,
    roomId: string,
    user: AuthUser,
    member: boolean,
  ): Promise<boolean> {
    const [room] = await tx
      .select()
      .from(battleRooms)
      .where(eq(battleRooms.id, roomId))
      .for('update');
    if (!room || room.status === 'EXPIRED' || room.status === 'FINISHED') {
      throw RoomErrors.notFound();
    }
    // 내 기록과 남아 있는 인원을 한 번에 읽는다
    const rows = await tx
      .select({
        userId: battleRoomParticipants.userId,
        active: battleRoomParticipants.active,
        state: battleRoomParticipants.state,
      })
      .from(battleRoomParticipants)
      .where(
        and(
          eq(battleRoomParticipants.roomId, room.id),
          or(
            eq(battleRoomParticipants.active, true),
            eq(battleRoomParticipants.userId, user.userId),
          ),
        ),
      );
    const mine = rows.find((row) => row.userId === user.userId);
    if (mine?.active) return false;
    if (mine?.state === 'KICKED') throw RoomErrors.kicked();
    if (room.status !== 'WAITING') throw RoomErrors.alreadyStarted();
    if (!member) throw RoomErrors.classOnly();
    const occupied = rows.filter((row) => row.active).length;
    if (occupied >= room.maxParticipants) throw RoomErrors.full();

    // 예전에 방장이었다 나간 사람이 다시 들어와도 방장 표시가 남지 않게 지운다
    const values = {
      state: 'CONNECTED' as const,
      active: true,
      isHost: false,
      joinedAt: new Date(),
      leftAt: null,
    };
    if (mine) {
      await tx
        .update(battleRoomParticipants)
        .set(values)
        .where(
          and(
            eq(battleRoomParticipants.roomId, room.id),
            eq(battleRoomParticipants.userId, user.userId),
          ),
        );
    } else {
      await tx
        .insert(battleRoomParticipants)
        .values({ roomId: room.id, userId: user.userId, ...values });
    }
    return true;
  }

  /** 빠른 매칭을 기다리다 직접 방에 들어가면 대기열에서 뺀다 (실패해도 대기 만료가 정리한다) */
  private async leaveMatchQueue(userId: string): Promise<void> {
    await this.matchQueue.remove(userId).catch(() => {});
  }

  async view(roomId: string): Promise<Room> {
    const [room] = await this.db.select().from(battleRooms).where(eq(battleRooms.id, roomId));
    if (!room) throw RoomErrors.notFound();
    const rows = await this.db
      .select({ participant: battleRoomParticipants, user: users })
      .from(battleRoomParticipants)
      .innerJoin(users, eq(users.id, battleRoomParticipants.userId))
      .where(
        and(eq(battleRoomParticipants.roomId, roomId), eq(battleRoomParticipants.active, true)),
      )
      .orderBy(asc(battleRoomParticipants.joinedAt));
    const [battle] = await this.db
      .select({ id: battles.id })
      .from(battles)
      .where(eq(battles.roomId, roomId));
    const base = this.config.get('SHARE_LINK_BASE', { infer: true }).replace(/\/$/, '');
    return {
      roomId: room.id,
      inviteCode: room.inviteCode,
      inviteUrl: `${base}/battle/rooms/${room.inviteCode}`,
      type: room.type,
      status: room.status,
      hostUserId: room.hostUserId,
      classId: room.classId,
      settings: {
        packId: room.packId,
        packName: room.packName,
        questionType: room.questionType as Room['settings']['questionType'],
        questionCount: room.questionCount,
        timeLimitSec: room.timeLimitSec,
        maxParticipants: room.maxParticipants,
      },
      participants: rows.map(({ participant, user }) => ({
        user: toUserSummary(user),
        state: participant.state,
        isHost: participant.isHost,
        joinedAt: participant.joinedAt.toISOString(),
      })),
      duplicateQuestions: room.duplicateQuestions,
      battleId: battle?.id ?? null,
      expiresAt: room.expiresAt.toISOString(),
    };
  }

  private async insertRoom(
    body: CreateRoom,
    pack: { id: string; name: string; wordCount: number },
    options: {
      type: BattleRoom['type'];
      hostUserId: string;
      classId: string | null;
      hostParticipates: boolean;
      guests?: string[];
      sourceBattleId: string | null;
      beforeInsert?: (tx: Transaction) => Promise<void>;
    },
  ): Promise<string> {
    const roomId = newId();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ROOM_TTL_MS);
    for (let attempt = 0; ; attempt++) {
      try {
        await this.db.transaction(async (tx) => {
          await options.beforeInsert?.(tx);
          await tx.insert(battleRooms).values({
            id: roomId,
            inviteCode: generateCode(),
            type: options.type,
            hostUserId: options.hostUserId,
            classId: options.classId,
            packId: pack.id,
            packName: pack.name,
            questionType: body.questionType,
            questionCount: body.questionCount,
            timeLimitSec: body.timeLimitSec,
            maxParticipants: body.maxParticipants,
            duplicateQuestions: pack.wordCount < body.questionCount,
            sourceBattleId: options.sourceBattleId,
            expiresAt,
          });
          if (options.hostParticipates) {
            await tx.insert(battleRoomParticipants).values({
              roomId,
              userId: options.hostUserId,
              isHost: true,
              joinedAt: now,
            });
          }
          for (const guest of options.guests ?? []) {
            await tx
              .insert(battleRoomParticipants)
              .values({ roomId, userId: guest, isHost: false, joinedAt: now });
          }
        });
        break;
      } catch (error) {
        if (isDuplicateKeyError(error, ACTIVE_CODE_INDEX)) {
          if (attempt < 4) continue;
          throw RoomErrors.codeUnavailable();
        }
        if (isDuplicateKeyError(error, ACTIVE_USER_INDEX)) {
          const codes = await Promise.all(
            [options.hostUserId, ...(options.guests ?? [])].map((id) => this.activeCodeOf(id)),
          );
          throw RoomErrors.alreadyJoined(codes.find(Boolean) ?? null);
        }
        throw error;
      }
    }
    await this.queue.scheduleExpiry(roomId, expiresAt);
    return roomId;
  }

  /** 진행 중인 방을 먼저 찾고, 없으면 그 코드를 쓴 가장 최근 방 (결과 화면으로 보내기 위해) */
  private async findByCode(inviteCode: string): Promise<BattleRoom | null> {
    if (!INVITE_CODE_PATTERN.test(inviteCode)) throw RoomErrors.invalidCode();
    const [room] = await this.db
      .select()
      .from(battleRooms)
      .where(eq(battleRooms.inviteCode, inviteCode))
      .orderBy(desc(battleRooms.createdAt))
      .limit(1);
    return room ?? null;
  }

  private async activeCodeOf(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ inviteCode: battleRooms.inviteCode })
      .from(battleRoomParticipants)
      .innerJoin(battleRooms, eq(battleRooms.id, battleRoomParticipants.roomId))
      .where(
        and(eq(battleRoomParticipants.userId, userId), eq(battleRoomParticipants.active, true)),
      );
    return row?.inviteCode ?? null;
  }

  private async inClass(classId: string | null, userId: string): Promise<boolean> {
    if (!classId) return false;
    const [row] = await this.db
      .select({ id: classes.id })
      .from(classes)
      .innerJoin(users, and(eq(users.grade, classes.grade), eq(users.classNo, classes.classNo)))
      .where(and(eq(classes.id, classId), eq(users.id, userId)));
    return Boolean(row);
  }

  private async countFailure(userId: string): Promise<void> {
    await this.valkey
      .multi()
      .incr(joinFailKey(userId))
      .expire(joinFailKey(userId), JOIN_FAIL_WINDOW_SECONDS)
      .exec()
      .catch(() => {});
  }

  /** 방에 남아 있는 참가자와 진행자(교사)에게 알린다 */
  private async notify(room: Room, type: string, payload: unknown, exceptUserId?: string) {
    const targets = new Set(room.participants.map((p) => p.user.userId));
    if (room.hostUserId) targets.add(room.hostUserId);
    if (exceptUserId) targets.delete(exceptUserId);
    await this.realtime.sendToUsers([...targets], type, payload).catch(() => {});
  }
}
