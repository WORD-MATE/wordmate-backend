import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { z } from 'zod';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { users } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { RealtimeService, ticketKey } from '../src/modules/realtime/realtime.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

type Received = {
  type: string;
  requestId: string | null;
  payload: Record<string, unknown>;
  serverTime: string;
};

/** 받은 메시지를 모아 두고 조건에 맞는 메시지를 기다린다 */
function connect(url: string) {
  const socket = new WebSocket(url);
  const received: Received[] = [];
  socket.on('message', (data) => received.push(JSON.parse(data.toString()) as Received));
  const closed = new Promise<number>((resolve) => socket.on('close', (code) => resolve(code)));
  const opened = new Promise<void>((resolve, reject) => {
    socket.on('open', () => resolve());
    socket.on('error', reject);
  });
  const waitFor = async (match: (m: Received) => boolean, count = 1) => {
    await expect
      .poll(() => received.filter(match).length, { timeout: 5000 })
      .toBeGreaterThanOrEqual(count);
    return received.filter(match);
  };
  const send = (body: object | string) =>
    socket.send(typeof body === 'string' ? body : JSON.stringify(body));
  return { socket, received, closed, opened, waitFor, send };
}

describe('실시간 게이트웨이', () => {
  let app: NestFastifyApplication;
  let other: NestFastifyApplication;
  let db: Database;
  let valkey: Redis;
  let realtime: RealtimeService;
  let wsBase: string;
  let otherWsBase: string;

  const makeUser = async (): Promise<AuthUser> => {
    const userId = newId();
    await db
      .insert(users)
      .values({ id: userId, name: '실시간', role: 'STUDENT', grade: 1, classNo: 1 });
    return { userId, role: 'STUDENT', isAdmin: false, deviceId: newId() };
  };

  const ticketFor = async (user: AuthUser) => {
    const res = await inject(app, {
      method: 'POST',
      url: '/realtime/ticket',
      headers: { authorization: `Bearer ${await app.get(AccessTokenService).sign(user)}` },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { ticket: string; expiresAt: string; wsUrl: string };
  };

  beforeAll(async () => {
    app = await createTestApp();
    db = app.get(DB);
    valkey = app.get(VALKEY);
    realtime = app.get(RealtimeService);
    realtime.handle('TEST_ECHO', z.object({ text: z.string().max(20) }), (ctx, payload) =>
      ctx.reply('TEST_ECHOED', { text: payload.text, userId: ctx.userId }),
    );
    await app.listen(0, '127.0.0.1');
    const { port } = app.getHttpServer().address() as AddressInfo;
    wsBase = `ws://127.0.0.1:${port}/ws`;
    other = await createTestApp();
    await other.listen(0, '127.0.0.1');
    otherWsBase = `ws://127.0.0.1:${(other.getHttpServer().address() as AddressInfo).port}/ws`;
  });

  afterAll(async () => {
    await other.close();
    await app.close();
  });

  it('티켓은 30초짜리 1회용이고 접속 주소를 알려준다', async () => {
    const user = await makeUser();
    const { ticket, expiresAt, wsUrl } = await ticketFor(user);
    expect(ticket).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(30_000);
    expect(wsUrl).toMatch(/^ws:\/\/.+\/ws$/);
    expect(await valkey.ttl(ticketKey(ticket))).toBeGreaterThan(0);

    const first = connect(`${wsBase}?ticket=${ticket}`);
    await first.opened;
    first.send({ type: 'TEST_ECHO', requestId: 'r1', payload: { text: 'hi' } });
    const [echo] = await first.waitFor((m) => m.type === 'TEST_ECHOED');
    expect(echo).toMatchObject({ requestId: 'r1', payload: { text: 'hi', userId: user.userId } });
    expect(echo?.serverTime).toEqual(expect.any(String));

    // 같은 티켓으로 다시 접속할 수 없다
    const reused = connect(`${wsBase}?ticket=${ticket}`);
    expect(await reused.closed).toBe(4401);
    first.socket.close();
  });

  it('티켓이 없거나 틀리면 4401로 끊는다', async () => {
    expect(await connect(wsBase).closed).toBe(4401);
    expect(await connect(`${wsBase}?ticket=${'0'.repeat(64)}`).closed).toBe(4401);
    expect(await connect(`${wsBase}?ticket=not-a-ticket`).closed).toBe(4401);
  });

  it('잘못된 메시지·모르는 메시지·잘못된 내용은 ERROR, 열자마자 보낸 메시지도 처리한다', async () => {
    const user = await makeUser();
    const client = connect(`${wsBase}?ticket=${(await ticketFor(user)).ticket}`);
    // 티켓 확인이 끝나기 전에 보낸 메시지
    client.socket.on('open', () =>
      client.send({ type: 'TEST_ECHO', requestId: 'early', payload: { text: 'a' } }),
    );
    await client.waitFor((m) => m.type === 'TEST_ECHOED' && m.requestId === 'early');

    client.send('not json');
    client.send({ type: 'NOPE', requestId: 'r2' });
    client.send({ type: 'TEST_ECHO', requestId: 'r3', payload: { text: 'x'.repeat(50) } });
    const errors = await client.waitFor((m) => m.type === 'ERROR', 3);
    expect(errors.map((e) => [e.requestId, e.payload.code])).toEqual([
      [null, 'WS_BAD_MESSAGE'],
      ['r2', 'WS_UNKNOWN_TYPE'],
      ['r3', 'INVALID_REQUEST'],
    ]);
    client.socket.close();
  });

  it('메시지를 너무 많이 보내면 한 번 알리고 나머지는 버린다', async () => {
    const user = await makeUser();
    const client = connect(`${wsBase}?ticket=${(await ticketFor(user)).ticket}`);
    await client.opened;
    for (let i = 0; i < 35; i++) client.send({ type: 'TEST_ECHO', payload: { text: String(i) } });
    await client.waitFor((m) => m.type === 'ERROR' && m.payload.code === 'RATE_LIMITED');
    await client.waitFor((m) => m.type === 'TEST_ECHOED', 30);
    expect(client.received.filter((m) => m.type === 'TEST_ECHOED')).toHaveLength(30);
    expect(client.received.filter((m) => m.type === 'ERROR')).toHaveLength(1);
    client.socket.close();
  });

  it('접속 상태를 Valkey에 남기고, 다른 인스턴스에서 보낸 메시지도 받는다', async () => {
    const user = await makeUser();
    const client = connect(`${wsBase}?ticket=${(await ticketFor(user)).ticket}`);
    await client.opened;
    await expect.poll(() => realtime.isOnline(user.userId)).toBe(true);

    await other.get(RealtimeService).sendToUsers([user.userId], 'HELLO', { from: 'other-node' });
    const [hello] = await client.waitFor((m) => m.type === 'HELLO');
    expect(hello).toMatchObject({ requestId: null, payload: { from: 'other-node' } });

    client.socket.close();
    await client.closed;
    await expect.poll(() => realtime.isOnline(user.userId)).toBe(false);
  });

  it('응답은 요청한 연결에만, 서버 쪽에서 보내는 메시지는 사용자의 모든 연결에', async () => {
    const user = await makeUser();
    const tabA = connect(`${wsBase}?ticket=${(await ticketFor(user)).ticket}`);
    const tabB = connect(`${wsBase}?ticket=${(await ticketFor(user)).ticket}`);
    await Promise.all([tabA.opened, tabB.opened]);

    tabA.send({ type: 'TEST_ECHO', requestId: 'only-a', payload: { text: 'a' } });
    await tabA.waitFor((m) => m.type === 'TEST_ECHOED');
    await realtime.sendToUsers([user.userId], 'BROADCAST', {});
    await tabB.waitFor((m) => m.type === 'BROADCAST');
    await tabA.waitFor((m) => m.type === 'BROADCAST');
    expect(tabB.received.some((m) => m.type === 'TEST_ECHOED')).toBe(false);
    tabA.socket.close();
    tabB.socket.close();
  });

  it('여러 서버에 붙은 사용자는 한쪽이 끊겨도 접속 중으로 남는다', async () => {
    const user = await makeUser();
    const phone = connect(`${wsBase}?ticket=${(await ticketFor(user)).ticket}`);
    const web = connect(`${otherWsBase}?ticket=${(await ticketFor(user)).ticket}`);
    await Promise.all([phone.opened, web.opened]);
    await expect.poll(() => realtime.isOnline(user.userId)).toBe(true);

    phone.socket.close();
    await phone.closed;
    // 끊긴 쪽이 정리를 마칠 시간을 준 뒤에도 다른 서버의 연결 때문에 접속 중이어야 한다
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await realtime.isOnline(user.userId)).toBe(true);

    web.socket.close();
    await web.closed;
    await expect.poll(() => realtime.isOnline(user.userId)).toBe(false);
  });
});
