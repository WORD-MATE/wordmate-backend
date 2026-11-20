import { Module } from '@nestjs/common';
import { PacksModule } from '../packs/packs.module.js';
import { XpModule } from '../xp/xp.module.js';
import { StudyController } from './study.controller.js';
import { StudyAnswersService } from './study-answers.service.js';
import { StudyCompleteService } from './study-complete.service.js';
import { StudySessionsService } from './study-sessions.service.js';

@Module({
  imports: [PacksModule, XpModule],
  controllers: [StudyController],
  providers: [StudySessionsService, StudyAnswersService, StudyCompleteService],
})
export class StudyModule {}
