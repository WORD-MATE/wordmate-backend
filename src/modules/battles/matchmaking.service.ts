import {
  type BeforeApplicationShutdown,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { and, asc, eq, gte, isNull } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException } from '../../common/errors/app-exception.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { packs, users } from '../../infra/db/schema/index.js';
import { blockedEitherWay } from '../blocks/block-queries.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { BattleQueue } from './battle.queue.js';
import type { CreateRoom } from './battle.schemas.js';
import { LobbyService } from './lobby.service.js';
import {
  type EnqueueResult,
  MATCH_TIMEOUT_MS,
  MatchQueue,
  PENDING_STALE_MS,
} from './match-queue.js';
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
const PAIR_ATTEMPTS = 3;
/** 연결이 열린 직후에는 서버가 티켓을 확인하는 중이라 아직 접속으로 잡히지 않을 수 있어 잠깐 기다린다 */
const ONLINE_WAIT_MS = 2000;
const ONLINE_POLL_MS = 50;

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
export class MatchmakingService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger(MatchmakingService.name);
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly matchQueue: MatchQueue,
    private readonly rooms: RoomsService,
    private readonly lobby: LobbyService,
    private readonly realtime: RealtimeService,
    private readonly queue: BattleQueue,
  ) {}

  onModuleInit(): void {
    // 결과를 받을 연결이 없으면 대기열에 남아 있을 이유가 없다 (다른 서버에 연결이 남아 있으면 그대로)
    this.realtime.onUserGone(async (userId) => {
      if (!(await this.realtime.isOnline(userId))) await this.matchQueue.remove(userId);
    });
  }

  /**
   * 대기 중인 사람 가운데 누적 XP가 가장 가까운 상대와 짝짓고, 없으면 60초 기다린다.
   * 결과는 WebSocket MATCH_FOUND { roomId, inviteCode } 또는 MATCH_TIMEOUT
   */
  async enqueue(user: AuthUser): Promise<MatchTicket> {
    if (!(await this.waitOnline(user.userId))) throw MatchErrors.wsRequired();
    await this.rooms.assertFree(user.userId);
    const pack = await this.defaultPack();
    if (!pack) throw MatchErrors.unavailable();
    const xp = await this.xpOf(user.userId);
    const excluded = await this.excluded(user.userId);
    const now = Date.now();
    const ticket = {
      queuedAt: new Date(now).toISOString(),
      timeoutAt: new Date(now + MATCH_TIMEOUT_MS).toISOString(),
    };
    const first = await this.matchQueue.enqueue(user.userId, xp, now, excluded);
    if (first.kind === 'ALREADY') throw MatchErrors.alreadyQueued();
    if (first.kind === 'QUEUED') {
      await this.scheduleTimeout(user.userId, now);
      return ticket;
    }
    // 성사된 뒤의 방 만들기·시작은 응답을 기다리게 하지 않는다 (결과는 MATCH_FOUND로 간다).
    // 동시에 많이 성사돼도 요청이 DB 연결을 기다리며 쌓이지 않는다
    const waiting = { userId: user.userId, xp, now, excluded };
    const running = this.completePairing(waiting, first, pack)
      .catch(async (error: unknown) => {
        this.logger.error(`빠른 매칭 성사 처리 실패 (${user.userId}): ${String(error)}`);
        await this.requeueOrDrop(waiting);
      })
      .finally(() => this.inFlight.delete(running));
    this.inFlight.add(running);
    return ticket;
  }

  /** 배포 등으로 꺼질 때 진행 중인 성사 처리를 끝낸 뒤 DB·Valkey 연결이 닫히게 한다 */
  async beforeApplicationShutdown(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }

  /**
   * 처리에 실패하면 원래 대기 시각으로 다시 줄 세운다(처리 중 표시도 함께 지운다).
   * 그사이 직접 다른 방에 들어갔으면 줄 세우지 않고 표시만 지운다
   */
  private async requeueOrDrop(waiting: { userId: string; xp: number; now: number }): Promise<void> {
    try {
      if (await this.isFree(waiting.userId)) {
        await this.matchQueue.requeue(waiting.userId, waiting.xp, waiting.now);
        await this.scheduleTimeout(waiting.userId, waiting.now);
      } else {
        await this.matchQueue.clearFound([waiting.userId]);
      }
    } catch (error) {
      this.logger.warn(`빠른 매칭 대기 복구 실패 (${waiting.userId}): ${String(error)}`);
    }
  }

  private async isFree(userId: string): Promise<boolean> {
    return this.rooms.assertFree(userId).then(
      () => true,
      () => false,
    );
  }

  /** 짝지은 상대를 쓸 수 없으면(연결이 끊겼거나 그사이 다른 방에 들어감) 빼고 다음 대기자를 본다 */
  private async completePairing(
    waiting: { userId: string; xp: number; now: number; excluded: string[] },
    matched: EnqueueResult,
    pack: NonNullable<Awaited<ReturnType<MatchmakingService['defaultPack']>>>,
  ): Promise<void> {
    let result = matched;
    for (let attempt = 0; attempt < PAIR_ATTEMPTS; attempt++) {
      if (result.kind === 'ALREADY') return;
      if (result.kind === 'QUEUED') {
        await this.scheduleTimeout(waiting.userId, waiting.now);
        return;
      }
      if (await this.pair(result.opponentId, result.opponentQueuedAt, waiting.userId, pack)) {
        return;
      }
      // 그사이 직접 다른 방에 들어갔으면 더 찾지 않는다
      if (!(await this.isFree(waiting.userId))) {
        await this.matchQueue.clearFound([waiting.userId]);
        return;
      }
      // 처리 중 표시는 그대로 둔 채(취소 요청이 사이에 끼어도 처리 중으로 보이게) 다음 대기자를 본다.
      // 그사이 생긴 차단도 반영한다
      waiting.excluded = await this.excluded(waiting.userId);
      result = await this.matchQueue.enqueue(
        waiting.userId,
        waiting.xp,
        waiting.now,
        waiting.excluded,
        true,
      );
    }
    // 계속 실패하면 대기만 한다 (다음에 들어오는 사람과 짝지어진다)
    await this.requeueOrDrop(waiting);
  }

  /**
   * 대기 중이면 뺀다. 성사와 겹치면 먼저 도착한 쪽 기준: 이미 성사됐으면 409 MATCH_ALREADY_FOUND.
   * 남아 있는 성사 기록은 그 방에 아직 있을 때만 믿는다 (방이 끝났거나 성사 처리가 중간에 끊긴 경우)
   */
  async cancel(user: AuthUser): Promise<void> {
    for (let waited = 0; ; waited += PENDING_POLL_MS) {
      const result = await this.matchQueue.cancel(user.userId);
      if (result.kind === 'CANCELLED') return;
      if (result.kind === 'NONE') throw MatchErrors.notQueued();
      const stale = result.kind === 'PENDING' && Date.now() - result.since > PENDING_STALE_MS;
      if (result.kind === 'FOUND' || stale) {
        const room = await this.rooms.activeRoomOf(user.userId);
        if (room && (result.kind !== 'FOUND' || room.roomId === result.roomId)) {
          throw MatchErrors.alreadyFound(room);
        }
        await this.matchQueue.clearFound([user.userId]);
        throw MatchErrors.notQueued();
      }
      // 방을 만드는 중이면 잠깐 기다려 보고, 그래도 안 끝났으면 이미 성사된 것으로 답한다 (MATCH_FOUND가 곧 간다)
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
   * 기다리던 상대의 연결이 끊겼거나 그사이 다른 방에 들어갔으면 상대를 빼고 false (요청한 사람은 다시 찾는다)
   */
  private async pair(
    hostId: string,
    hostQueuedAt: number,
    guestId: string,
    pack: NonNullable<Awaited<ReturnType<MatchmakingService['defaultPack']>>>,
  ): Promise<boolean> {
    // 요청한 사람의 처리 중 표시는 다음 상대를 찾을 때까지 그대로 둔다
    if (!(await this.realtime.isOnline(hostId))) {
      await this.matchQueue.clearFound([hostId]);
      return false;
    }
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
        return false;
      }
      // 방을 만들다 실패하면 기다리던 상대는 원래 대기 시각으로 되돌리고 요청한 사람에게 에러를 돌려준다
      await this.matchQueue.requeue(hostId, await this.xpOf(hostId), hostQueuedAt);
      await this.scheduleTimeout(hostId, hostQueuedAt);
      throw error;
    }
    // 기록에 실패해도 알림은 보낸다 (취소 요청은 방에 들어가 있는지로 다시 확인한다)
    await this.matchQueue.found([hostId, guestId], room).catch(() => {});
    await this.realtime.sendToUsers([hostId, guestId], 'MATCH_FOUND', room).catch(() => {});
    await this.lobby
      .start(hostId, room.roomId)
      .catch((error: unknown) =>
        this.logger.warn(`빠른 매칭 시작 실패 (${room.roomId}): ${String(error)}`),
      );
    return true;
  }

  /**
   * 클라이언트는 연결이 열리자마자 매칭을 요청할 수 있는데, 서버는 그 뒤 티켓을 확인하고서야 접속으로 등록한다.
   * 그 사이에 온 요청을 거절하지 않도록 등록될 때까지 잠깐 기다린다 (다른 서버에 붙은 연결은 Valkey 기록으로 확인)
   */
  private async waitOnline(userId: string): Promise<boolean> {
    for (let waited = 0; ; waited += ONLINE_POLL_MS) {
      if (await this.realtime.isOnline(userId)) return true;
      if (waited >= ONLINE_WAIT_MS) return false;
      await new Promise((resolve) => setTimeout(resolve, ONLINE_POLL_MS));
    }
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
  /** 내가 차단했거나 나를 차단한 사용자와는 짝짓지 않는다 */
  private excluded(userId: string): Promise<string[]> {
    return blockedEitherWay(this.db, userId);
  }

  private async scheduleTimeout(userId: string, queuedAt: number): Promise<void> {
    await this.queue
      .scheduleMatchTimeout(userId, queuedAt, new Date(queuedAt + MATCH_TIMEOUT_MS))
      .catch((error: unknown) =>
        this.logger.warn(`매칭 만료 예약 실패 (${userId}): ${String(error)}`),
      );
  }
}
