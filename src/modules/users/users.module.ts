import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PoliciesModule } from '../policies/policies.module.js';
import { XpModule } from '../xp/xp.module.js';
import { AgreementService } from './agreement.service.js';
import { NextStepService } from './next-step.service.js';
import { OnboardingGuard } from './onboarding.guard.js';
import { TeacherClassService } from './teacher-class.service.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [PoliciesModule, XpModule],
  controllers: [UsersController],
  providers: [
    AgreementService,
    NextStepService,
    TeacherClassService,
    UsersService,
    { provide: APP_GUARD, useClass: OnboardingGuard },
  ],
  exports: [AgreementService, NextStepService, TeacherClassService],
})
export class UsersModule {}
