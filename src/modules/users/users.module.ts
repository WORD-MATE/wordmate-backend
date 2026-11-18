import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PoliciesModule } from '../policies/policies.module.js';
import { AgreementService } from './agreement.service.js';
import { NextStepService } from './next-step.service.js';
import { TermsGuard } from './terms.guard.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [PoliciesModule],
  controllers: [UsersController],
  providers: [
    AgreementService,
    NextStepService,
    UsersService,
    { provide: APP_GUARD, useClass: TermsGuard },
  ],
  exports: [NextStepService],
})
export class UsersModule {}
