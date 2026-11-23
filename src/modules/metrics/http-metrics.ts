import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { MetricsService } from './metrics.service.js';

/** 매칭된 라우트가 없으면 주소마다 라벨이 늘어나지 않게 하나로 묶는다 */
export const UNMATCHED_ROUTE = 'UNMATCHED';

const HEALTH_PATH = '/health';

export const routeLabel = (request: Pick<FastifyRequest, 'routeOptions'>): string =>
  request.routeOptions.url ?? UNMATCHED_ROUTE;

export const isHealthRoute = (route: string): boolean =>
  route === HEALTH_PATH || route.startsWith(`${HEALTH_PATH}/`);

/**
 * 라우트가 등록되기 전에 불러야 한다. 상태 확인은 10초마다 오므로 요청 지표·접속 로그에서 뺀다
 * (오류는 로그에 남도록 warn 이상만 남긴다)
 */
export function instrumentHttp(fastify: FastifyInstance, metrics: MetricsService): void {
  // 서버 기본 수준이 이미 warn보다 조용하면(error·silent) 오히려 시끄러워지므로 건드리지 않는다
  const quieter = !['warn', 'error', 'fatal', 'silent'].includes(fastify.log.level);
  fastify.addHook('onRoute', (route) => {
    if (quieter && isHealthRoute(route.url)) route.logLevel = 'warn';
  });
  fastify.addHook('onResponse', async (request, reply) => {
    const route = routeLabel(request);
    if (isHealthRoute(route)) return;
    metrics.observeHttp(request.method, route, reply.statusCode, reply.elapsedTime / 1000);
  });
}
