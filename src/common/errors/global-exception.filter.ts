import { type ArgumentsHost, Catch, type ExceptionFilter, Logger } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { toErrorResponse } from './error-response.js';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const { status, body } = toErrorResponse(exception);

    if (status >= 500) {
      this.logger.error(
        `${request.method} ${request.url} traceId=${request.id}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    reply.status(status).send({ ...body, traceId: request.id });
  }
}
