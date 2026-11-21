import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { expect } from 'vitest';
import WebSocket from 'ws';
import { AccessTokenService } from '../../src/common/auth/access-token.service.js';
import type { AuthUser } from '../../src/common/auth/auth-user.js';
import { inject } from './create-test-app.js';

export type WsMessage = {
  type: string;
  requestId: string | null;
  payload: Record<string, unknown>;
  serverTime: string;
};

export type WsClient = Awaited<ReturnType<typeof connectAs>>;

/** listen(0) 한 앱의 /ws 주소 */
export const wsBaseOf = (app: NestFastifyApplication) =>
  `ws://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/ws`;

/** 티켓을 받아 접속하고, 받은 메시지를 모아 두었다가 조건에 맞는 것을 기다린다 */
export async function connectAs(app: NestFastifyApplication, user: AuthUser) {
  const res = await inject(app, {
    method: 'POST',
    url: '/realtime/ticket',
    headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
  });
  const socket = new WebSocket(`${wsBaseOf(app)}?ticket=${res.json().ticket}`);
  const received: WsMessage[] = [];
  socket.on('message', (data) => received.push(JSON.parse(data.toString()) as WsMessage));
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });

  const matching = (type: string, where: Record<string, unknown> = {}) =>
    received.filter(
      (m) => m.type === type && Object.entries(where).every(([k, v]) => m.payload[k] === v),
    );
  return {
    user,
    socket,
    received,
    closed,
    send: (type: string, payload: object = {}, requestId: string | null = null) =>
      socket.send(JSON.stringify({ type, requestId, payload })),
    /** 조건에 맞는 메시지가 올 때까지 기다려 마지막 것을 돌려준다 */
    waitFor: async (type: string, where: Record<string, unknown> = {}, timeout = 5000) => {
      await expect.poll(() => matching(type, where).length, { timeout }).toBeGreaterThan(0);
      return matching(type, where).at(-1) as WsMessage;
    },
    has: (type: string, where: Record<string, unknown> = {}) => matching(type, where).length > 0,
    close: async () => {
      socket.close();
      await closed;
    },
  };
}
