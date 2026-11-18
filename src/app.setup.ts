import { randomUUID } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { GlobalExceptionFilter } from './common/errors/global-exception.filter.js';
import { setupSwagger } from './common/swagger.js';
import { ZodResponseInterceptor } from './common/zod/zod-response.interceptor.js';

export function createFastifyAdapter(): FastifyAdapter {
  return new FastifyAdapter({ genReqId: () => randomUUID() });
}

export function setupApp(app: NestFastifyApplication, options: { swagger: boolean }): void {
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new ZodResponseInterceptor(app.get(Reflector)));
  if (options.swagger) setupSwagger(app);
}
