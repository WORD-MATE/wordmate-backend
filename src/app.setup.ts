import { randomUUID } from 'node:crypto';
import helmet from '@fastify/helmet';
import { Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyServerOptions } from 'fastify';
import { GlobalExceptionFilter } from './common/errors/global-exception.filter.js';
import { PinoNestLogger } from './common/logging/pino-nest-logger.js';
import { setupSwagger } from './common/swagger.js';
import { ZodResponseInterceptor } from './common/zod/zod-response.interceptor.js';
import type { Env } from './config/env.js';

const BODY_LIMIT_BYTES = 1024 * 1024;

export const CLIENT_HEADERS = ['X-Client-Platform', 'X-Client-Version', 'Idempotency-Key'];

export function createFastifyAdapter(env: Pick<Env, 'NODE_ENV' | 'LOG_LEVEL'>): FastifyAdapter {
  const logger: FastifyServerOptions['logger'] = {
    level: env.LOG_LEVEL,
    redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    ...(env.NODE_ENV === 'development' && { transport: { target: 'pino-pretty' } }),
  };
  return new FastifyAdapter({
    genReqId: () => randomUUID(),
    requestIdLogLabel: 'traceId',
    bodyLimit: BODY_LIMIT_BYTES,
    logger,
  });
}

export async function setupApp(
  app: NestFastifyApplication,
  options: { swagger: boolean; corsOrigins: string[] },
): Promise<void> {
  app.useLogger(new PinoNestLogger(app.getHttpAdapter().getInstance().log));
  await app.register(helmet, { contentSecurityPolicy: false });
  app.enableCors({
    origin: options.corsOrigins.length > 0 ? options.corsOrigins : false,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', ...CLIENT_HEADERS],
    exposedHeaders: ['Retry-After', 'Idempotent-Replayed'],
  });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new ZodResponseInterceptor(app.get(Reflector)));
  if (options.swagger) setupSwagger(app);
}
