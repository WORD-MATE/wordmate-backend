import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getQueueToken } from '@nestjs/bullmq';
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Counter, collectDefaultMetrics, Gauge, Histogram, Registry } from '@prometheus-io/client';
import type { Queue } from 'bullmq';
import { withTimeout } from '../../common/with-timeout.js';
import { BATTLE_QUEUE } from '../battles/battle.queue.js';
import { JOB_QUEUES } from '../jobs/job-registry.js';
import { PUSH_QUEUE } from '../push/push.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';

export const METRICS_PATH = '/metrics';
export const METRIC_QUEUES = [...new Set([...JOB_QUEUES, BATTLE_QUEUE, PUSH_QUEUE])].sort();
export const QUEUE_STATES = ['waiting', 'active', 'delayed', 'failed'] as const;
// 수집 주기(15초)보다 훨씬 짧게. Valkey가 느려도 나머지 지표는 내보낸다
const QUEUE_TIMEOUT_MS = 1000;
const HTTP_BUCKETS = [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Prometheus 지표. 테스트에서 앱을 여러 번 만들어도 겹치지 않게 전역 레지스트리 대신 앱마다 따로 둔다.
 * 외부에 열리지 않도록 API 포트가 아닌 내부 포트(METRICS_PORT)로만 내보낸다
 */
@Injectable()
export class MetricsService implements OnApplicationShutdown {
  private readonly logger = new Logger(MetricsService.name);
  readonly registry = new Registry();
  private readonly httpRequests: Counter<'method' | 'route' | 'status'>;
  private readonly httpDuration: Histogram<'method' | 'route' | 'status'>;
  private server: Server | null = null;

  constructor(
    private readonly moduleRef: ModuleRef,
    realtime: RealtimeService,
  ) {
    const registers = [this.registry];
    collectDefaultMetrics({ register: this.registry });
    this.httpRequests = new Counter({
      name: 'http_requests_total',
      help: 'HTTP 요청 수',
      labelNames: ['method', 'route', 'status'],
      registers,
    });
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP 요청 처리 시간 (초)',
      labelNames: ['method', 'route', 'status'],
      buckets: HTTP_BUCKETS,
      registers,
    });
    new Gauge({
      name: 'wordmate_realtime_connections',
      help: '이 인스턴스에 인증을 마치고 붙어 있는 실시간 연결 수',
      registers,
      collect() {
        this.set(realtime.connectionCount);
      },
    });
    // 두 지표가 한 번의 수집에서 같은 값을 쓰도록 읽는 중인 결과를 함께 쓴다
    let reading: Promise<Map<string, Record<string, number> | null>> | null = null;
    const readQueues = () => {
      reading ??= this.readAllQueues().finally(() => {
        reading = null;
      });
      return reading;
    };
    new Gauge({
      name: 'wordmate_queue_jobs',
      help: '큐 상태별 작업 수',
      labelNames: ['queue', 'state'],
      registers,
      collect: async function (this: Gauge<'queue' | 'state'>) {
        const counts = await readQueues();
        this.reset();
        for (const [queue, count] of counts) {
          if (!count) continue;
          for (const state of QUEUE_STATES) this.set({ queue, state }, count[state] ?? 0);
        }
      },
    });
    new Gauge({
      name: 'wordmate_queue_up',
      help: '큐 작업 수를 시간 안에 읽었으면 1',
      labelNames: ['queue'],
      registers,
      collect: async function (this: Gauge<'queue'>) {
        for (const [queue, count] of await readQueues()) this.set({ queue }, count ? 1 : 0);
      },
    });
  }

  private async readAllQueues(): Promise<Map<string, Record<string, number> | null>> {
    const counts = await Promise.all(METRIC_QUEUES.map((name) => this.jobCounts(name)));
    return new Map(METRIC_QUEUES.map((name, index) => [name, counts[index] ?? null]));
  }

  observeHttp(method: string, route: string, status: number, seconds: number): void {
    const labels = { method, route, status: String(status) };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, seconds);
  }

  /** 0이면 빈 포트를 고른다. 실제로 연 포트를 돌려준다 */
  async listen(port: number, host: string): Promise<number> {
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (req.method !== 'GET' || path !== METRICS_PATH) {
        res.writeHead(404).end();
        return;
      }
      this.registry.metrics().then(
        (body) => res.writeHead(200, { 'Content-Type': this.registry.contentType }).end(body),
        (error: unknown) => {
          this.logger.error(`지표 수집 실패: ${String(error)}`);
          res.writeHead(500).end();
        },
      );
    });
    server.listen(port, host);
    await once(server, 'listening');
    this.server = server;
    return (server.address() as AddressInfo).port;
  }

  async onApplicationShutdown(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async jobCounts(name: string): Promise<Record<string, number> | null> {
    try {
      const queue = this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
      return await withTimeout(queue.getJobCounts(...QUEUE_STATES), QUEUE_TIMEOUT_MS);
    } catch {
      return null;
    }
  }
}
