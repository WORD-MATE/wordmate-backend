import { Module } from '@nestjs/common';
import { PacksModule } from '../packs/packs.module.js';
import { StudyController } from './study.controller.js';
import { StudyAnswersService } from './study-answers.service.js';
import { StudySessionsService } from './study-sessions.service.js';

@Module({
  imports: [PacksModule],
  controllers: [StudyController],
  providers: [StudySessionsService, StudyAnswersService],
})
export class StudyModule {}
