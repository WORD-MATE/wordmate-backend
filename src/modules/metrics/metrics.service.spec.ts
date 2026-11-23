import type { ModuleRef } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { RealtimeService } from '../realtime/realtime.service.js';
import { isHealthRoute, routeLabel, UNMATCHED_ROUTE } from './http-metrics.js';
import { METRIC_QUEUES, MetricsService } from './metrics.service.js';

function makeService(getQueue: (token: string) => unknown, connectionCount = 0) {
  const moduleRef = { get: (token: string) => getQueue(token) } as unknown as ModuleRef;
  const realtime = { connectionCount } as RealtimeService;
  return new MetricsService(moduleRef, realtime);
}

const fakeQueue = (counts: Record<string, number>) => ({
  getJobCounts: async (...states: string[]) =>
    Object.fromEntries(states.map((state) => [state, counts[state] ?? 0])),
});

describe('MetricsService', () => {
  let service: MetricsService | null = null;

  afterEach(async () => {
    await service?.onApplicationShutdown();
    service = null;
  });

  it('요청 수·지연을 메서드·라우트·상태 코드로 센다', async () => {
    service = makeService(() => fakeQueue({}));
    service.observeHttp('GET', '/packs/:id', 200, 0.03);
    service.observeHttp('GET', '/packs/:id', 200, 0.2);
    service.observeHttp('POST', '/study/sessions', 500, 1.5);
    const text = await service.registry.metrics();
    expect(text).toContain('http_requests_total{method="GET",route="/packs/:id",status="200"} 2');
    expect(text).toContain(
      'http_requests_total{method="POST",route="/study/sessions",status="500"} 1',
    );
    expect(text).toContain(
      'http_request_duration_seconds_bucket{le="0.05",method="GET",route="/packs/:id",status="200"} 1',
    );
  });

  it('실시간 연결 수와 큐 작업 수를 수집할 때 읽는다', async () => {
    service = makeService(() => fakeQueue({ waiting: 3, active: 1, failed: 2 }), 7);
    const text = await service.registry.metrics();
    expect(text).toContain('wordmate_realtime_connections 7');
    expect(text).toContain('wordmate_queue_jobs{queue="battle",state="waiting"} 3');
    expect(text).toContain('wordmate_queue_jobs{queue="battle",state="failed"} 2');
    expect(text).toContain('wordmate_queue_up{queue="push"} 1');
    expect(text).toContain('process_cpu_user_seconds_total');
  });

  it('응답하지 않거나 없는 큐는 0으로 표시하고 나머지는 그대로 내보낸다', async () => {
    const slow = METRIC_QUEUES[0];
    service = makeService((token) => {
      if (token.endsWith(`${slow}`)) return { getJobCounts: () => new Promise(() => {}) };
      if (token.endsWith('push')) throw new Error('not registered');
      return fakeQueue({ active: 4 });
    });
    const text = await service.registry.metrics();
    expect(text).toContain(`wordmate_queue_up{queue="${slow}"} 0`);
    expect(text).toContain('wordmate_queue_up{queue="push"} 0');
    expect(text).not.toContain(`wordmate_queue_jobs{queue="${slow}"`);
    expect(text).toContain('wordmate_queue_jobs{queue="ranking",state="active"} 4');
  });

  it('내부 포트에서는 GET /metrics만 응답한다', async () => {
    service = makeService(() => fakeQueue({}));
    const port = await service.listen(0, '127.0.0.1');
    const ok = await fetch(`http://127.0.0.1:${port}/metrics`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toContain('text/plain');
    expect(await ok.text()).toContain('wordmate_realtime_connections');
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'POST' })).status).toBe(404);
  });
});

describe('라우트 라벨', () => {
  it('매칭된 라우트는 패턴을, 없으면 하나로 묶는다', () => {
    expect(routeLabel({ routeOptions: { url: '/packs/:id' } } as never)).toBe('/packs/:id');
    expect(routeLabel({ routeOptions: { url: undefined } } as never)).toBe(UNMATCHED_ROUTE);
  });

  it('상태 확인 라우트만 고른다', () => {
    expect(isHealthRoute('/health')).toBe(true);
    expect(isHealthRoute('/health/ready')).toBe(true);
    expect(isHealthRoute('/healthy')).toBe(false);
    expect(isHealthRoute('/app/status')).toBe(false);
  });
});
