import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { WebSocket } from 'ws';
import type { ZodType, z } from 'zod';
import { AppException } from '../../common/errors/app-exception.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';

export const TICKET_TTL_SECONDS = 30;
export const PING_INTERVAL_MS = 30_000;
/** ping 두 번을 놓쳐도 살아 있으면 접속 중으로 본다 */
const PRESENCE_TTL_SECONDS = 90;
const RATE_WINDOW_MS = 10_000;
const RATE_LIMIT = 30;
const DELIVER_CHANNEL = 'rt:deliver';

export const ticketKey = (ticket: string) => `ws:ticket:${ticket}`;
export const presenceKey = (userId: string) => `ws:online:${userId}`;

export type ServerMessage = {
  type: string;
  requestId: string | null;
  payload: unknown;
  serverTime: string;
};

export type RealtimeContext = { userId: string; requestId: string | null };
type Handler = { schema: ZodType; run: (ctx: RealtimeContext, payload: unknown) => unknown };

type Connection = {
  socket: WebSocket;
  userId: string;
  alive: boolean;
  windowStart: number;
  count: number;
};

export const RealtimeErrors = {
  badMessage: () => new AppException('WS_BAD_MESSAGE', '메시지 형식이 올바르지 않습니다.', 400),
  unknownType: (type: string) =>
    new AppException('WS_UNKNOWN_TYPE', `알 수 없는 메시지입니다: ${type}`, 400),
  invalidPayload: () =>
    new AppException('INVALID_REQUEST', '메시지 내용이 올바르지 않습니다.', 400),
  rateLimited: () => new AppException('RATE_LIMITED', '메시지를 너무 자주 보냈습니다.', 429),
};

const message = (type: string, payload: unknown, requestId: string | null = null): string =>
  JSON.stringify({ type, requestId, payload, serverTime: new Date().toISOString() });

/**
 * 접속·인증·메시지 라우팅·접속 상태를 맡는다. 방·대결 같은 기능은 handle()로 메시지 처리기를 등록하고,
 * sendToUsers()로 보낸다. 보내기는 Valkey pub/sub을 거쳐 사용자가 붙어 있는 인스턴스에서 전달된다
 */
@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly nodeId = randomUUID();
  private readonly handlers = new Map<string, Handler>();
  private readonly connections = new Map<WebSocket, Connection>();
  private readonly byUser = new Map<string, Set<WebSocket>>();
  private subscriber: Redis | null = null;
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async onModuleInit(): Promise<void> {
    this.subscriber = this.valkey.duplicate();
    this.subscriber.on('error', (error) => this.logger.warn(error.message));
    this.subscriber.on('message', (_channel, raw) => this.deliverLocal(raw));
    // 구독을 기다리면 Valkey가 없을 때 앱 시작이 멈추므로 기다리지 않는다
    void this.subscriber
      .subscribe(DELIVER_CHANNEL)
      .catch((error: unknown) => this.logger.error(`실시간 구독 실패: ${String(error)}`));
    this.heartbeat = setInterval(() => void this.beat(), PING_INTERVAL_MS);
    this.heartbeat.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const socket of this.connections.keys()) socket.terminate();
    this.subscriber?.disconnect();
  }

  handle<S extends ZodType>(
    type: string,
    schema: S,
    run: (ctx: RealtimeContext, payload: z.infer<S>) => unknown,
  ): void {
    if (this.handlers.has(type)) throw new Error(`이미 등록된 실시간 메시지: ${type}`);
    this.handlers.set(type, { schema, run: run as Handler['run'] });
  }

  async issueTicket(userId: string): Promise<{ ticket: string; expiresAt: Date }> {
    const ticket = randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '');
    await this.valkey.set(ticketKey(ticket), userId, 'EX', TICKET_TTL_SECONDS, 'NX');
    return { ticket, expiresAt: new Date(Date.now() + TICKET_TTL_SECONDS * 1000) };
  }

  /** 티켓은 1회용이라 꺼내면서 지운다 */
  async redeemTicket(ticket: string | null): Promise<string | null> {
    if (!ticket || !/^[0-9a-f]{64}$/.test(ticket)) return null;
    return this.valkey.getdel(ticketKey(ticket));
  }

  async isOnline(userId: string): Promise<boolean> {
    return (await this.valkey.exists(presenceKey(userId))) === 1;
  }

  async sendToUsers(userIds: string[], type: string, payload: unknown): Promise<void> {
    if (userIds.length === 0) return;
    await this.valkey.publish(DELIVER_CHANNEL, JSON.stringify({ userIds, type, payload }));
  }

  /** 인증된 연결을 등록한다. 인증 전에 온 메시지는 게이트웨이가 모아 두었다가 넘긴다 */
  attach(socket: WebSocket, userId: string): void {
    const connection: Connection = {
      socket,
      userId,
      alive: true,
      windowStart: Date.now(),
      count: 0,
    };
    this.connections.set(socket, connection);
    const sockets = this.byUser.get(userId) ?? new Set();
    sockets.add(socket);
    this.byUser.set(userId, sockets);
    socket.on('pong', () => {
      connection.alive = true;
    });
    void this.valkey
      .set(presenceKey(userId), this.nodeId, 'EX', PRESENCE_TTL_SECONDS)
      .catch(() => {});
  }

  async detach(socket: WebSocket): Promise<void> {
    const connection = this.connections.get(socket);
    if (!connection) return;
    this.connections.delete(socket);
    const sockets = this.byUser.get(connection.userId);
    sockets?.delete(socket);
    if (sockets && sockets.size === 0) {
      this.byUser.delete(connection.userId);
      // 다른 인스턴스에 같은 사용자의 연결이 있을 수 있어 내 노드가 쓴 값일 때만 지운다
      const owner = await this.valkey.get(presenceKey(connection.userId)).catch(() => null);
      if (owner === this.nodeId)
        await this.valkey.del(presenceKey(connection.userId)).catch(() => {});
    }
  }

  async receive(socket: WebSocket, raw: string): Promise<void> {
    const connection = this.connections.get(socket);
    if (!connection) return;
    let requestId: string | null = null;
    try {
      const now = Date.now();
      if (now - connection.windowStart > RATE_WINDOW_MS) {
        connection.windowStart = now;
        connection.count = 0;
      }
      connection.count++;
      if (connection.count > RATE_LIMIT) {
        // 한도를 넘긴 첫 메시지에만 알려 주고 나머지는 버린다
        if (connection.count === RATE_LIMIT + 1) throw RealtimeErrors.rateLimited();
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw RealtimeErrors.badMessage();
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof (parsed as { type?: unknown }).type !== 'string'
      ) {
        throw RealtimeErrors.badMessage();
      }
      const { type, payload } = parsed as { type: string; payload?: unknown };
      const rawRequestId = (parsed as { requestId?: unknown }).requestId;
      requestId = typeof rawRequestId === 'string' ? rawRequestId.slice(0, 64) : null;

      const handler = this.handlers.get(type);
      if (!handler) throw RealtimeErrors.unknownType(type.slice(0, 64));
      const result = handler.schema.safeParse(payload ?? {});
      if (!result.success) throw RealtimeErrors.invalidPayload();
      await handler.run({ userId: connection.userId, requestId }, result.data);
    } catch (error) {
      if (error instanceof AppException) {
        socket.send(message('ERROR', { code: error.code, message: error.message }, requestId));
        return;
      }
      this.logger.error(`실시간 메시지 처리 실패: ${String(error)}`);
      socket.send(
        message(
          'ERROR',
          { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' },
          requestId,
        ),
      );
    }
  }

  /** 같은 사용자의 이 인스턴스 연결에 직접 보낸다 (요청에 대한 응답용) */
  reply(userId: string, type: string, payload: unknown, requestId: string | null = null): void {
    for (const socket of this.byUser.get(userId) ?? [])
      socket.send(message(type, payload, requestId));
  }

  private deliverLocal(raw: string): void {
    try {
      const { userIds, type, payload } = JSON.parse(raw) as {
        userIds: string[];
        type: string;
        payload: unknown;
      };
      const text = message(type, payload);
      for (const userId of userIds) {
        for (const socket of this.byUser.get(userId) ?? []) socket.send(text);
      }
    } catch (error) {
      this.logger.warn(`실시간 전달 실패: ${String(error)}`);
    }
  }

  /** ping에 답이 없는 연결은 끊고, 살아 있는 사용자의 접속 상태를 연장한다 */
  private async beat(): Promise<void> {
    const pipeline = this.valkey.pipeline();
    for (const [socket, connection] of this.connections) {
      if (!connection.alive) {
        socket.terminate();
        continue;
      }
      connection.alive = false;
      socket.ping();
      pipeline.set(presenceKey(connection.userId), this.nodeId, 'EX', PRESENCE_TTL_SECONDS);
    }
    await pipeline.exec().catch(() => {});
  }
}
