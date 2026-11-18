import { randomUUID } from 'node:crypto';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { GlobalExceptionFilter } from './common/errors/global-exception.filter.js';

export function createFastifyAdapter(): FastifyAdapter {
  return new FastifyAdapter({ genReqId: () => randomUUID() });
}

export function setupApp(app: NestFastifyApplication): void {
  app.useGlobalFilters(new GlobalExceptionFilter());
}
