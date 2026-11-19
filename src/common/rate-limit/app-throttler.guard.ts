import { type ExecutionContext, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';

export const USER_LIMIT_PER_MINUTE = 120;
// 학생들이 학교 공인 IP 하나를 함께 쓰고 학교 프록시도 실제 IP를 넘기지 않아서,
// 비로그인 요청의 IP 제한은 사실상 서버 전체 상한으로 동작한다
export const ANONYMOUS_LIMIT_PER_MINUTE = 600;

export const defaultLimit = (context: ExecutionContext): number =>
  context.switchToHttp().getRequest<FastifyRequest>().user
    ? USER_LIMIT_PER_MINUTE
    : ANONYMOUS_LIMIT_PER_MINUTE;

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as FastifyRequest;
    return request.user ? `user:${request.user.userId}` : `ip:${request.ip}`;
  }
}
