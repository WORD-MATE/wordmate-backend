import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, asc, eq, gte, isNull } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException } from '../../common/errors/app-exception.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { packs, users } from '../../infra/db/schema/index.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { BattleQueue } from './battle.queue.js';
import type { CreateRoom } from './battle.schemas.js';
import { LobbyService } from './lobby.service.js';
import { MATCH_TIMEOUT_MS, MatchQueue } from './match-queue.js';
import { MIN_BATTLE_WORDS, RoomsService } from './rooms.service.js';

/** 빠른 매칭 기본 설정: 기본 단어팩, 한→영 4지선다, 10문항, 10초, 1:1 */
export const QUICK_MATCH_SETTINGS = {
  questionType: 'KO_TO_EN_CHOICE',
  questionCount: 10,
  timeLimitSec: 10,
  maxParticipants: 2,
} as const;

/** 취소 요청이 방을 만드는 중인 성사와 겹치면 결과가 나올 때까지 잠깐 기다린다 */
const PENDING_WAIT_MS = 3000;
const PENDING_POLL_MS = 100;

export const MatchErrors = {
  wsRequired: () =>
    new AppException(
      'MATCH_WS_NOT_CONNECTED',
      '실시간 연결 후에 매칭할 수 있습니다.',
      HttpStatus.CONFLICT,
    ),
  alreadyQueued: () =>
    new AppException('MATCH_ALREADY_QUEUED', '이미 매칭을 기다리는 중입니다.', HttpStatus.CONFLICT),
  notQueued: () =>
    new AppException('MATCH_NOT_QUEUED', '기다리는 매칭이 없습니다.', HttpStatus.NOT_FOUND),
  alreadyFound: (room: { roomId: string; inviteCode: string } | null) =>
    new AppException(
      'MATCH_ALREADY_FOUND',
      '이미 상대를 찾았습니다.',
      HttpStatus.CONFLICT,
      room ? { roomId: room.roomId, inviteCode: room.inviteCode } : null,
    ),
  unavailable: () =>
    new AppException(
      'MATCH_UNAVAILABLE',
      '지금은 빠른 매칭을 할 수 없습니다.',
      HttpStatus.SERVICE_UNAVAILABLE,
    ),
};

export type MatchTicket = { queuedAt: string; timeoutAt: string };

@Injectable()
export class MatchmakingService implements OnModuleInit {
  private readonly logger = new Logger(MatchmakingService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly matchQueue: MatchQueue,
    private readonly rooms: RoomsService,
    private readonly lobby: LobbyService,
    private readonly realtime: RealtimeService,
    private readonly queue: BattleQueue,
  ) {}

  onModuleInit(): void {
    // 결과를 받을 연결이 없으면 대기열에 남아 있을 이유가 없다
    this.realtime.onUserGone((userId) => this.matchQueue.remove(userId));
  }

  /**
   * 대기 중인 사람 가운데 누적 XP가 가장 가까운 상대와 짝짓고, 없으면 60초 기다린다.
   * 결과는 WebSocket MATCH_FOUND { roomId, inviteCode } 또는 MATCH_TIMEOUT
   */
  async enqueue(user: AuthUser): Promise<MatchTicket> {
    if (!(await this.realtime.isOnline(user.userId))) throw MatchErrors.wsRequired();
    await this.rooms.assertFree(user.userId);
    const pack = await this.defaultPack();
    if (!pack) throw MatchErrors.unavailable();
    const xp = await this.xpOf(user.userId);
    const now = Date.now();
    const result = await this.matchQueue.enqueue(
      user.userId,
      xp,
      now,
      await this.excluded(user.userId),
    );
    if (result.kind === 'ALREADY') throw MatchErrors.alreadyQueued();
    const ticket = {
      queuedAt: new Date(now).toISOString(),
      timeoutAt: new Date(now + MATCH_TIMEOUT_MS).toISOString(),
    };
    if (result.kind === 'QUEUED') {
      await this.scheduleTimeout(user.userId, now);
      return ticket;
    }
    await this.pair(result.opponentId, result.opponentQueuedAt, user.userId, now, pack);
    return ticket;
  }

  /** 대기 중이면 뺀다. 성사와 겹치면 먼저 도착한 쪽 기준: 이미 성사됐으면 409 MATCH_ALREADY_FOUND */
  async cancel(user: AuthUser): Promise<void> {
    for (let waited = 0; ; waited += PENDING_POLL_MS) {
      const result = await this.matchQueue.cancel(user.userId);
      if (result.kind === 'CANCELLED') return;
      if (result.kind === 'NONE') throw MatchErrors.notQueued();
      if (result.kind === 'FOUND') throw MatchErrors.alreadyFound(result);
      if (waited >= PENDING_WAIT_MS) throw MatchErrors.alreadyFound(null);
      await new Promise((resolve) => setTimeout(resolve, PENDING_POLL_MS));
    }
  }

  /** 대기 만료 작업. 그사이 성사·취소됐거나 다시 줄을 섰으면 아무것도 하지 않는다 */
  async expire(userId: string, queuedAt: number): Promise<void> {
    if (await this.matchQueue.expire(userId, queuedAt)) {
      await this.realtime.sendToUsers([userId], 'MATCH_TIMEOUT', {}).catch(() => {});
    }
  }

  /**
   * 방을 만들고 두 사람에게 MATCH_FOUND를 보낸 뒤 바로 카운트다운을 시작한다.
   * 기다리던 상대가 그사이 다른 방에 들어갔으면 상대는 빼고 요청한 사람을 대기열에 넣는다
   */
  private async pair(
    hostId: string,
    hostQueuedAt: number,
    guestId: string,
    guestQueuedAt: number,
    pack: NonNullable<Awaited<ReturnType<MatchmakingService['defaultPack']>>>,
  ): Promise<void> {
    let room: { roomId: string; inviteCode: string };
    try {
      const created = await this.rooms.createQuickMatch(hostId, guestId, pack, {
        packId: pack.id,
        ...QUICK_MATCH_SETTINGS,
      } satisfies CreateRoom);
      room = { roomId: created.roomId, inviteCode: created.inviteCode };
    } catch (error) {
      const hostBusy = await this.rooms.assertFree(hostId).then(
        () => false,
        () => true,
      );
      if (hostBusy) {
        await this.matchQueue.clearFound([hostId]);
        await this.matchQueue.requeue(guestId, await this.xpOf(guestId), guestQueuedAt);
        await this.scheduleTimeout(guestId, guestQueuedAt);
        return;
      }
      await this.matchQueue.requeue(hostId, await this.xpOf(hostId), hostQueuedAt);
      await this.matchQueue.clearFound([guestId]);
      throw error;
    }
    await this.matchQueue.found([hostId, guestId], room);
    await this.realtime.sendToUsers([hostId, guestId], 'MATCH_FOUND', room).catch(() => {});
    await this.lobby
      .start(hostId, room.roomId)
      .catch((error: unknown) =>
        this.logger.warn(`빠른 매칭 시작 실패 (${room.roomId}): ${String(error)}`),
      );
  }

  /** 추천순으로 가장 앞에 있는 기본 단어팩 (단어 10개 이상) */
  private async defaultPack() {
    const [pack] = await this.db
      .select()
      .from(packs)
      .where(
        and(
          eq(packs.type, 'DEFAULT'),
          isNull(packs.deletedAt),
          gte(packs.wordCount, MIN_BATTLE_WORDS),
        ),
      )
      .orderBy(asc(packs.sortOrder), asc(packs.createdAt))
      .limit(1);
    return pack ?? null;
  }

  private async xpOf(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ totalXp: users.totalXp })
      .from(users)
      .where(eq(users.id, userId));
    return row?.totalXp ?? 0;
  }

  /** 차단 관계(양방향)인 사용자. 차단 기능이 생기면 여기서 돌려준다 */
  private async excluded(_userId: string): Promise<string[]> {
    return [];
  }

  private async scheduleTimeout(userId: string, queuedAt: number): Promise<void> {
    await this.queue
      .scheduleMatchTimeout(userId, queuedAt, new Date(queuedAt + MATCH_TIMEOUT_MS))
      .catch((error: unknown) =>
        this.logger.warn(`매칭 만료 예약 실패 (${userId}): ${String(error)}`),
      );
  }
}
