import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { ACCESS_TOKEN_TTL_SECONDS } from './access-token.service.js';

const keyOf = (userId: string) => `auth:blocked:${userId}`;

/**
 * 정지한 사용자의 남은 액세스 토큰을 바로 막는다. 세션(리프레시 토큰)은 따로 폐기하므로
 * 이미 발급된 액세스 토큰이 끝날 때까지만 남겨 두면 된다
 */
@Injectable()
export class AccountBlockService {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async block(userId: string): Promise<void> {
    await this.valkey.set(keyOf(userId), '1', 'EX', ACCESS_TOKEN_TTL_SECONDS + 60);
  }

  async unblock(userId: string): Promise<void> {
    await this.valkey.del(keyOf(userId));
  }

  async isBlocked(userId: string): Promise<boolean> {
    return (await this.valkey.exists(keyOf(userId))) === 1;
  }
}
