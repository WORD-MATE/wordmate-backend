import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { DataGsmClient } from './datagsm/datagsm.client.js';
import { SessionService } from './session.service.js';

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [AuthService, SessionService, DataGsmClient],
  exports: [DataGsmClient, SessionService],
})
export class AuthModule {}
