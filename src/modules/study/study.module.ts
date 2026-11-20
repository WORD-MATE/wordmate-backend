import { Module } from '@nestjs/common';
import { PacksModule } from '../packs/packs.module.js';
import { StudyController } from './study.controller.js';
import { StudySessionsService } from './study-sessions.service.js';

@Module({
  imports: [PacksModule],
  controllers: [StudyController],
  providers: [StudySessionsService],
})
export class StudyModule {}
