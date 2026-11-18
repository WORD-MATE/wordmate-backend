import type { LoggerService } from '@nestjs/common';
import type { FastifyBaseLogger } from 'fastify';

export class PinoNestLogger implements LoggerService {
  constructor(private readonly pino: FastifyBaseLogger) {}

  log(message: unknown, context?: string) {
    this.pino.info({ context }, String(message));
  }

  error(message: unknown, stack?: string, context?: string) {
    this.pino.error({ context, stack }, String(message));
  }

  warn(message: unknown, context?: string) {
    this.pino.warn({ context }, String(message));
  }

  debug(message: unknown, context?: string) {
    this.pino.debug({ context }, String(message));
  }

  verbose(message: unknown, context?: string) {
    this.pino.trace({ context }, String(message));
  }

  fatal(message: unknown, context?: string) {
    this.pino.fatal({ context }, String(message));
  }
}
