import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import type { Env } from '../../config/env.js';

export const VALKEY = Symbol('VALKEY');

@Global()
@Module({
  providers: [
    {
      provide: VALKEY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): Redis =>
        new Redis(config.get('VALKEY_URL', { infer: true })),
    },
  ],
  exports: [VALKEY],
})
export class ValkeyModule implements OnApplicationShutdown {
  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.valkey.quit();
  }
}
