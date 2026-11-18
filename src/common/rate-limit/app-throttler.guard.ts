import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const request = req as unknown as FastifyRequest;
    return request.user ? `user:${request.user.userId}` : `ip:${request.ip}`;
  }
}
