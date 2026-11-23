import { Module } from '@nestjs/common';
import { BadgesModule } from '../badges/badges.module.js';
import { RankingModule } from '../ranking/ranking.module.js';
import { XpModule } from '../xp/xp.module.js';
import { MissionsController } from './missions.controller.js';
import { MissionsService } from './missions.service.js';

@Module({
  imports: [BadgesModule, XpModule, RankingModule],
  controllers: [MissionsController],
  providers: [MissionsService],
  exports: [MissionsService],
})
export class MissionsModule {}
