import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BadgesModule } from '../badges/badges.module.js';
import { RankingModule } from '../ranking/ranking.module.js';
import { XpModule } from '../xp/xp.module.js';
import { CHALLENGE_QUEUE, ChallengeProcessor } from './challenge.processor.js';
import { ChallengesController } from './challenges.controller.js';
import { ChallengesService } from './challenges.service.js';

@Module({
  imports: [
    BullModule.registerQueue({ name: CHALLENGE_QUEUE }),
    BadgesModule,
    XpModule,
    RankingModule,
  ],
  controllers: [ChallengesController],
  providers: [ChallengesService, ChallengeProcessor],
})
export class ChallengesModule {}
