import type { CallHandler, ExecutionContext, NestInterceptor } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';
import type { ZodType } from 'zod';
import { ZOD_RESPONSE } from './decorators.js';

export class ZodResponseInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const schema = this.reflector.get<ZodType | undefined>(ZOD_RESPONSE, context.getHandler());
    if (!schema) return next.handle();
    return next.handle().pipe(map((data) => schema.parse(data)));
  }
}
