import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { PoliciesModule } from '../policies/policies.module.js';
import { XpModule } from '../xp/xp.module.js';
import { AgreementService } from './agreement.service.js';
import { NextStepService } from './next-step.service.js';
import { OnboardingGuard } from './onboarding.guard.js';
import { TeacherClassService } from './teacher-class.service.js';
import { UserDirectoryController } from './user-directory.controller.js';
import { UserDirectoryService } from './user-directory.service.js';
import { AvatarsController, UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [PoliciesModule, XpModule],
  controllers: [UsersController, AvatarsController, UserDirectoryController],
  providers: [
    AgreementService,
    NextStepService,
    TeacherClassService,
    UserDirectoryService,
    UsersService,
    { provide: APP_GUARD, useClass: OnboardingGuard },
  ],
  exports: [AgreementService, NextStepService, TeacherClassService],
})
export class UsersModule {}
