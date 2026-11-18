import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { VALKEY } from '../infra/valkey/valkey.module.js';
import { AppConfigService } from './app-config/app-config.service.js';
import { AuthGuard } from './auth/auth.guard.js';
import { ClientGuard } from './client/client.guard.js';
import { AppThrottlerGuard } from './rate-limit/app-throttler.guard.js';
import { ValkeyThrottlerStorage } from './rate-limit/valkey-throttler.storage.js';

@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [VALKEY],
      useFactory: (valkey: Redis) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: 120 }],
        storage: new ValkeyThrottlerStorage(valkey),
      }),
    }),
  ],
  providers: [
    AppConfigService,
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: ClientGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AppConfigService],
})
export class CommonModule {}
