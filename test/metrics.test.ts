import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AppConfig, AppConfigService } from '../src/common/app-config/app-config.service.js';
import { HealthController } from '../src/modules/health/health.controller.js';
import { METRIC_QUEUES, MetricsService } from '../src/modules/metrics/metrics.service.js';
import { createTestApp, inject } from './support/create-test-app.js';

const base: AppConfig = {
  maintenance: { enabled: false, message: '', endsAt: null },
  minVersion: {},
  latestVersion: {},
  storeUrl: {},
};

describe('상태 확인·지표', () => {
  let app: NestFastifyApplication;
  let config: AppConfig = base;
  let metricsUrl: string;

  const scrape = async () => {
    const res = await fetch(metricsUrl);
    expect(res.status).toBe(200);
    return res.text();
  };

  beforeAll(async () => {
    app = await createTestApp({
      overrides: [[AppConfigService, { get: async () => config }]],
    });
    const port = await app.get(MetricsService).listen(0, '127.0.0.1');
    metricsUrl = `http://127.0.0.1:${port}/metrics`;
  });

  beforeEach(() => {
    config = base;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live는 의존 서비스를 보지 않고 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/live' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', uptimeSeconds: expect.any(Number) });
  });

  it('GET /health/ready는 DB·Valkey 응답 시간을 함께 돌려준다', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      checks: {
        db: { status: 'up', latencyMs: expect.any(Number) },
        valkey: { status: 'up', latencyMs: expect.any(Number) },
      },
    });
  });

  it('점검 중이거나 최소 버전보다 낮아도 클라이언트 헤더 없이 상태 확인을 받는다', async () => {
    config = {
      ...base,
      maintenance: { enabled: true, message: '정기 점검', endsAt: null },
      minVersion: { IOS: '99.0.0' },
    };
    expect((await inject(app, { url: '/packs' })).statusCode).toBe(503);
    for (const url of ['/health', '/health/live', '/health/ready']) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(200);
    }
  });

  it('API 포트에는 /metrics가 없다', async () => {
    const res = await inject(app, { url: '/metrics' });
    expect(res.statusCode).toBe(404);
  });

  it('요청 수·지연을 라우트 패턴으로 모으고 상태 확인은 빼고 센다', async () => {
    await inject(app, { url: '/packs/0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' });
    await inject(app, { url: '/no-such-route/123' });
    await app.inject({ method: 'GET', url: '/health' });

    const text = await scrape();
    expect(text).toMatch(
      /http_requests_total\{method="GET",route="\/packs\/:packId",status="4\d\d"\} 1/,
    );
    expect(text).toMatch(/http_requests_total\{method="GET",route="UNMATCHED",status="404"\} \d+/);
    expect(text).toContain(
      'http_request_duration_seconds_bucket{le="0.1",method="GET",route="/packs/:packId"',
    );
    expect(text).not.toContain('route="/health');
    expect(text).not.toContain('0198a1b2');
  });

  it('실시간 연결 수·큐 작업 수·프로세스 지표를 내보낸다', async () => {
    const text = await scrape();
    expect(text).toMatch(/^wordmate_realtime_connections \d+$/m);
    for (const queue of METRIC_QUEUES) {
      expect(text).toContain(`wordmate_queue_up{queue="${queue}"} 1`);
      expect(text).toMatch(
        new RegExp(`wordmate_queue_jobs\\{queue="${queue}",state="failed"\\} \\d+`),
      );
    }
    expect(text).toContain('process_resident_memory_bytes');
    expect(text).toContain('nodejs_eventloop_lag_seconds');
  });

  it('종료가 시작되면 /health/ready는 503 SHUTTING_DOWN', async () => {
    app.get(HealthController).onModuleDestroy();
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: 'SHUTTING_DOWN' });
  });
});
