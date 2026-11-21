import type { IncomingMessage } from 'node:http';
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { WebSocket } from 'ws';
import { RealtimeService } from './realtime.service.js';

export const WS_PATH = '/ws';
/** 대결 메시지는 작으므로 큰 메시지로 메모리를 쓰게 하지 않는다 */
const MAX_PAYLOAD_BYTES = 16 * 1024;
const UNAUTHORIZED_CLOSE_CODE = 4401;

@WebSocketGateway({ path: WS_PATH, maxPayload: MAX_PAYLOAD_BYTES })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(private readonly realtime: RealtimeService) {}

  /**
   * 열리자마자 보낸 메시지도 잃지 않도록 티켓 확인 전에 온 메시지는 모아 두었다가 넘긴다.
   * 한 연결의 메시지는 받은 순서대로 하나씩 처리한다
   */
  async handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const pending: string[] = [];
    let ready = false;
    let chain = Promise.resolve();
    const enqueue = (raw: string) => {
      chain = chain.then(() => this.realtime.receive(socket, raw)).catch(() => {});
    };
    socket.on('message', (data) => {
      const raw = data.toString();
      if (ready) enqueue(raw);
      else pending.push(raw);
    });

    const ticket = new URL(request.url ?? '', 'http://localhost').searchParams.get('ticket');
    const userId = await this.realtime.redeemTicket(ticket).catch(() => null);
    if (!userId) {
      socket.close(UNAUTHORIZED_CLOSE_CODE, 'unauthorized');
      return;
    }
    this.realtime.attach(socket, userId);
    ready = true;
    for (const raw of pending) enqueue(raw);
  }

  async handleDisconnect(socket: WebSocket): Promise<void> {
    await this.realtime.detach(socket);
  }
}
