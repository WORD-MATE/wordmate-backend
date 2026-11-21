import { Module } from '@nestjs/common';
import { RankingController } from './ranking.controller.js';
import { RankingService } from './ranking.service.js';
import { RankingQueryService } from './ranking-query.service.js';

@Module({
  controllers: [RankingController],
  providers: [RankingService, RankingQueryService],
  exports: [RankingService, RankingQueryService],
})
export class RankingModule {}
