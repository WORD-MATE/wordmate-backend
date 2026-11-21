import { Module } from '@nestjs/common';
import { PacksModule } from '../packs/packs.module.js';
import { RankingModule } from '../ranking/ranking.module.js';
import { XpModule } from '../xp/xp.module.js';
import { StudyController, StudyReviewController } from './study.controller.js';
import { StudyAnswersService } from './study-answers.service.js';
import { StudyCompleteService } from './study-complete.service.js';
import { StudySessionsService } from './study-sessions.service.js';

@Module({
  imports: [PacksModule, RankingModule, XpModule],
  controllers: [StudyController, StudyReviewController],
  providers: [StudySessionsService, StudyAnswersService, StudyCompleteService],
  exports: [StudySessionsService],
})
export class StudyModule {}
