import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.js';
import { parseValkeyUrl } from '../valkey/parse-valkey-url.js';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        connection: parseValkeyUrl(config.get('VALKEY_URL', { infer: true })),
      }),
    }),
  ],
})
export class QueueModule {}
