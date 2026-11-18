import {
  type CallHandler,
  type ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { catchError, concatMap, from, type Observable, of, switchMap } from 'rxjs';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { AppException, CommonErrors } from '../errors/app-exception.js';
import { IDEMPOTENT } from './idempotent.decorator.js';

const TTL_SECONDS = 24 * 60 * 60;
const PROCESSING = '__processing__';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Stored = { body: unknown };

const UNAVAILABLE = Symbol('UNAVAILABLE');

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.reflector.get<boolean>(IDEMPOTENT, context.getHandler())) return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const idempotencyKey = request.headers['idempotency-key'];
    if (idempotencyKey === undefined) return next.handle();
    if (typeof idempotencyKey !== 'string' || !UUID.test(idempotencyKey)) {
      throw CommonErrors.invalidRequest(
        { header: 'Idempotency-Key' },
        'Idempotency-Key는 UUID여야 합니다.',
      );
    }

    const scope = request.user?.userId ?? `ip:${request.ip}`;
    const key = `idem:${scope}:${request.method}:${request.routeOptions.url}:${idempotencyKey}`;

    return from(this.begin(key)).pipe(
      switchMap((stored) => {
        if (stored === UNAVAILABLE) return next.handle();
        if (stored) {
          http.getResponse<FastifyReply>().header('Idempotent-Replayed', 'true');
          return of(stored.body);
        }
        return next.handle().pipe(
          concatMap(async (body) => {
            await this.valkey
              .set(key, JSON.stringify({ body } satisfies Stored), 'EX', TTL_SECONDS)
              .catch((error) => this.logger.warn(`멱등 응답 저장 실패: ${String(error)}`));
            return body;
          }),
          catchError(async (error) => {
            await this.valkey.del(key).catch(() => {});
            throw error;
          }),
        );
      }),
    );
  }

  private async begin(key: string): Promise<Stored | null | typeof UNAVAILABLE> {
    try {
      return await this.acquire(key);
    } catch (error) {
      if (error instanceof AppException) throw error;
      // Valkey 장애 시 요청 자체를 막지 않고 멱등 처리 없이 진행한다
      this.logger.warn(`멱등 키 확인 실패, 그대로 처리합니다: ${String(error)}`);
      return UNAVAILABLE;
    }
  }

  private async acquire(key: string): Promise<Stored | null> {
    const acquired = await this.valkey.set(key, PROCESSING, 'EX', TTL_SECONDS, 'NX');
    if (acquired) return null;

    const value = await this.valkey.get(key);
    if (value === null) return this.acquire(key);
    if (value === PROCESSING) {
      throw new AppException(
        'IDEMPOTENCY_IN_PROGRESS',
        '같은 요청을 처리하고 있습니다. 잠시 후 다시 시도하세요.',
        HttpStatus.CONFLICT,
      );
    }
    return JSON.parse(value) as Stored;
  }
}
