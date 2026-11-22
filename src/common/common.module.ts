import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import type { Redis } from 'ioredis';
import { VALKEY } from '../infra/valkey/valkey.module.js';
import { AppConfigService } from './app-config/app-config.service.js';
import { AuditLogService } from './audit/audit-log.service.js';
import { AccessTokenService } from './auth/access-token.service.js';
import { AccountBlockService } from './auth/account-block.service.js';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthenticationGuard } from './auth/authentication.guard.js';
import { ClientGuard } from './client/client.guard.js';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor.js';
import { AppThrottlerGuard, defaultLimit } from './rate-limit/app-throttler.guard.js';
import { ValkeyThrottlerStorage } from './rate-limit/valkey-throttler.storage.js';

@Global()
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [VALKEY],
      useFactory: (valkey: Redis) => ({
        throttlers: [{ name: 'default', ttl: 60_000, limit: defaultLimit }],
        storage: new ValkeyThrottlerStorage(valkey),
      }),
    }),
  ],
  providers: [
    AppConfigService,
    AccessTokenService,
    AccountBlockService,
    AuditLogService,
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    { provide: APP_GUARD, useClass: ClientGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [AppConfigService, AccessTokenService, AccountBlockService, AuditLogService],
})
export class CommonModule {}
