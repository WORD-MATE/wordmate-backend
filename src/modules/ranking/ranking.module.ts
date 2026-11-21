import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { RankingController } from './ranking.controller.js';
import { RANKING_QUEUE, RankingProcessor } from './ranking.processor.js';
import { RankingService } from './ranking.service.js';
import { RankingQueryService } from './ranking-query.service.js';
import { SeasonService } from './season.service.js';

@Module({
  imports: [BullModule.registerQueue({ name: RANKING_QUEUE })],
  controllers: [RankingController],
  providers: [RankingService, RankingQueryService, SeasonService, RankingProcessor],
  exports: [RankingService, RankingQueryService],
})
export class RankingModule {}
