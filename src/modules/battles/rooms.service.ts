import { randomInt } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, asc, count, desc, eq, inArray, lte, or } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException, CommonErrors } from '../../common/errors/app-exception.js';
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
import { PacksService } from '../packs/packs.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { toUserSummary } from '../users/user-summary.js';
import { BattleQueue } from './battle.queue.js';
import { type CreateRoom, INVITE_CODE_PATTERN, type Room } from './battle.schemas.js';
import { BattleErrors } from './battle-results.service.js';

type Rematch = { pack: Pack; battleId: string };

export const ROOM_TTL_MS = 30 * 60 * 1000;
/** 문항 30개 × (15초 + 결과 2초)보다 넉넉히. 이보다 오래 진행 중이면 멈춘 방으로 보고 닫는다 */
export const MAX_BATTLE_MS = 30 * 60 * 1000;
/** 카운트다운이 끝나고 이만큼 지나도 시작 작업이 안 돌았으면 예약이 유실된 것으로 보고 대기실로 돌린다 */
export const COUNTDOWN_STALL_MS = 30 * 1000;
const EXPIRY_RECHECK_MS = 60 * 1000;
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
  ) {}

  /** 만든 사람이 방장이자 첫 참가자 */
  async create(user: AuthUser, body: CreateRoom, rematch?: Rematch): Promise<Room> {
    const pack = rematch?.pack ?? (await this.packs.findVisible(user, body.packId));
    if (pack.wordCount < MIN_BATTLE_WORDS) throw RoomErrors.packTooFewWords();
    await this.releaseExpired(user.userId);
    const roomId = await this.insertRoom(body, pack, {
      type: 'NORMAL',
      hostUserId: user.userId,
      classId: null,
      hostParticipates: true,
      sourceBattleId: rematch?.battleId ?? null,
    });
    return this.view(roomId);
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
    const pack = await this.packs.findById(room.packId);
    if (room.type === 'CLASS') {
      if (room.hostUserId !== user.userId || !room.classId) {
        throw CommonErrors.forbidden('교사용 방은 진행한 교사만 다시 할 수 있습니다.');
      }
      return this.createForClass(user, room.classId, body, { pack, battleId });
    }
    const [played] = await this.db
      .select({ userId: battleResults.userId })
      .from(battleResults)
      .where(and(eq(battleResults.battleId, battleId), eq(battleResults.userId, user.userId)));
    if (!played) throw CommonErrors.forbidden('참가하지 않은 대결입니다.');
    if (user.role !== 'STUDENT') throw CommonErrors.forbidden();
    return this.create(user, body, { pack, battleId });
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
    if (!owned) throw CommonErrors.forbidden('담당 반이 아닙니다.');
    const pack = rematch?.pack ?? (await this.packs.findVisible(user, body.packId));
    if (pack.wordCount < MIN_BATTLE_WORDS) throw RoomErrors.packTooFewWords();
    await this.expireOverdue();
    await this.recoverStalledHostedBy(user.userId);
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
    await this.expireIfOverdue(room);
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
    await this.expireIfOverdue(found);
    await this.releaseExpired(user.userId);

    const [student] = await this.db
      .select({ grade: users.grade, classNo: users.classNo })
      .from(users)
      .where(eq(users.id, user.userId));
    let joined = false;
    try {
      joined = await this.db.transaction(async (tx) => {
        const [room] = await tx
          .select()
          .from(battleRooms)
          .where(eq(battleRooms.id, found.id))
          .for('update');
        if (!room || room.status === 'EXPIRED' || room.status === 'FINISHED') {
          throw RoomErrors.notFound();
        }
        const [mine] = await tx
          .select()
          .from(battleRoomParticipants)
          .where(
            and(
              eq(battleRoomParticipants.roomId, room.id),
              eq(battleRoomParticipants.userId, user.userId),
            ),
          );
        if (mine?.active) return false;
        if (mine?.state === 'KICKED') throw RoomErrors.kicked();
        if (room.status !== 'WAITING') throw RoomErrors.alreadyStarted();
        if (room.type === 'CLASS' && !(await this.inClass(tx, room.classId, student))) {
          throw RoomErrors.classOnly();
        }
        const [occupied] = await tx
          .select({ total: count() })
          .from(battleRoomParticipants)
          .where(
            and(
              eq(battleRoomParticipants.roomId, room.id),
              eq(battleRoomParticipants.active, true),
            ),
          );
        if ((occupied?.total ?? 0) >= room.maxParticipants) throw RoomErrors.full();

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
      });
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
    return room;
  }

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
        });
        break;
      } catch (error) {
        if (isDuplicateKeyError(error, ACTIVE_CODE_INDEX)) {
          if (attempt < 4) continue;
          throw RoomErrors.codeUnavailable();
        }
        if (isDuplicateKeyError(error, ACTIVE_USER_INDEX)) {
          throw RoomErrors.alreadyJoined(await this.activeCodeOf(options.hostUserId));
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

  private async expireIfOverdue(room: BattleRoom): Promise<void> {
    if (room.status === 'WAITING' && room.expiresAt <= new Date()) await this.expire(room.id);
  }

  /**
   * 지연 작업이 늦어져도 만료된 방이 사용자를 붙잡지 않게 참가 전에 정리한다.
   * 이미 끝난 방에 활성으로 남은 참가 기록도 풀어 준다
   */
  private async releaseExpired(userId: string): Promise<void> {
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
  private async recoverStalledHostedBy(hostUserId: string): Promise<void> {
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

  private async expireOverdue(): Promise<void> {
    const overdue = await this.db
      .select({ id: battleRooms.id })
      .from(battleRooms)
      .where(and(eq(battleRooms.status, 'WAITING'), lte(battleRooms.expiresAt, new Date())));
    for (const room of overdue) await this.expire(room.id);
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

  private async inClass(
    tx: Transaction,
    classId: string | null,
    student: { grade: number | null; classNo: number | null } | undefined,
  ): Promise<boolean> {
    if (!classId || !student) return false;
    const [cls] = await tx
      .select({ grade: classes.grade, classNo: classes.classNo })
      .from(classes)
      .where(eq(classes.id, classId));
    return Boolean(cls && cls.grade === student.grade && cls.classNo === student.classNo);
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
