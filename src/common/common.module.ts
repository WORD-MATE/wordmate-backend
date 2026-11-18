import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppConfigService } from './app-config/app-config.service.js';
import { AuthGuard } from './auth/auth.guard.js';
import { ClientGuard } from './client/client.guard.js';

@Global()
@Module({
  providers: [
    AppConfigService,
    { provide: APP_GUARD, useClass: ClientGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AppConfigService],
})
export class CommonModule {}
