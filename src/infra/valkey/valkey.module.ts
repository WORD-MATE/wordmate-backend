import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { withTimeout } from '../../common/with-timeout.js';
import type { Env } from '../../config/env.js';

export const VALKEY = Symbol('VALKEY');

const SHUTDOWN_TIMEOUT_MS = 2000;

@Global()
@Module({
  providers: [
    {
      provide: VALKEY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Redis => {
        // 기본값(20회 재시도)이면 Valkey 장애 시 요청이 오래 멈춤
        const valkey = new Redis(config.get('VALKEY_URL', { infer: true }), {
          maxRetriesPerRequest: 1,
        });
        const logger = new Logger('Valkey');
        valkey.on('error', (error) => logger.warn(error.message));
        return valkey;
      },
    },
  ],
  exports: [VALKEY],
})
export class ValkeyModule implements OnApplicationShutdown {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await withTimeout(this.valkey.quit(), SHUTDOWN_TIMEOUT_MS).catch(() => {
      this.valkey.disconnect();
    });
  }
}
