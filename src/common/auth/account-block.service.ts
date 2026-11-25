import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { withTimeout } from '../with-timeout.js';
import { ACCESS_TOKEN_TTL_SECONDS } from './access-token.service.js';

const keyOf = (userId: string) => `auth:blocked:${userId}`;
const adminRevokedKeyOf = (userId: string) => `auth:admin-revoked:${userId}`;
const READ_TIMEOUT_MS = 300;

export type BlockKind = 'SUSPENDED' | 'WITHDRAWN';

/**
 * 정지·탈퇴한 사용자의 남은 액세스 토큰을 바로 막는다. 세션(리프레시 토큰)은 따로 폐기하므로
 * 이미 발급된 액세스 토큰이 끝날 때까지만 남겨 두면 된다
 */
@Injectable()
export class AccountBlockService {
  private readonly logger = new Logger(AccountBlockService.name);

  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async block(userId: string, kind: BlockKind = 'SUSPENDED'): Promise<void> {
    // 정지는 예전부터 '1'로 저장해 왔다
    const value = kind === 'WITHDRAWN' ? 'W' : '1';
    await this.valkey.set(keyOf(userId), value, 'EX', ACCESS_TOKEN_TTL_SECONDS + 60);
  }

  async unblock(userId: string): Promise<void> {
    await this.valkey.del(keyOf(userId));
  }

  /** 관리자 권한을 회수하면 이미 받은 액세스 토큰의 관리자 표시를 토큰이 끝날 때까지 무시한다 */
  async revokeAdmin(userId: string): Promise<void> {
    await this.valkey.set(adminRevokedKeyOf(userId), '1', 'EX', ACCESS_TOKEN_TTL_SECONDS + 60);
  }

  async restoreAdmin(userId: string): Promise<void> {
    await this.valkey.del(adminRevokedKeyOf(userId));
  }

  /** 확인하지 못하면 회수되지 않은 것으로 본다 (정지 확인과 같은 기준) */
  async isAdminRevoked(userId: string): Promise<boolean> {
    try {
      return (
        (await withTimeout(this.valkey.get(adminRevokedKeyOf(userId)), READ_TIMEOUT_MS)) !== null
      );
    } catch (error) {
      this.logger.warn(`관리자 회수 확인 실패: ${String(error)}`);
      return false;
    }
  }

  async isBlocked(userId: string): Promise<boolean> {
    return (await this.blockedAs(userId)) !== null;
  }

  /** Valkey 장애로 모든 요청이 막히지 않게, 확인하지 못하면 통과시킨다 (토큰 수명 안에서만 열림) */
  async blockedAs(userId: string): Promise<BlockKind | null> {
    try {
      const value = await withTimeout(this.valkey.get(keyOf(userId)), READ_TIMEOUT_MS);
      if (value === null) return null;
      return value === 'W' ? 'WITHDRAWN' : 'SUSPENDED';
    } catch (error) {
      this.logger.warn(`계정 차단 확인 실패: ${String(error)}`);
      return null;
    }
  }
}
