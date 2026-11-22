import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { withTimeout } from '../with-timeout.js';
import { ACCESS_TOKEN_TTL_SECONDS } from './access-token.service.js';

const keyOf = (userId: string) => `auth:blocked:${userId}`;
const READ_TIMEOUT_MS = 300;

/**
 * 정지한 사용자의 남은 액세스 토큰을 바로 막는다. 세션(리프레시 토큰)은 따로 폐기하므로
 * 이미 발급된 액세스 토큰이 끝날 때까지만 남겨 두면 된다
 */
@Injectable()
export class AccountBlockService {
  private readonly logger = new Logger(AccountBlockService.name);

  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async block(userId: string): Promise<void> {
    await this.valkey.set(keyOf(userId), '1', 'EX', ACCESS_TOKEN_TTL_SECONDS + 60);
  }

  async unblock(userId: string): Promise<void> {
    await this.valkey.del(keyOf(userId));
  }

  /** Valkey 장애로 모든 요청이 막히지 않게, 확인하지 못하면 통과시킨다 (토큰 수명 안에서만 열림) */
  async isBlocked(userId: string): Promise<boolean> {
    try {
      return (await withTimeout(this.valkey.exists(keyOf(userId)), READ_TIMEOUT_MS)) === 1;
    } catch (error) {
      this.logger.warn(`정지 차단 확인 실패: ${String(error)}`);
      return false;
    }
  }
}
