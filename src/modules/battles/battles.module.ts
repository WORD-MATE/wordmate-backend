import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { BadgesModule } from '../badges/badges.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PacksModule } from '../packs/packs.module.js';
import { RankingModule } from '../ranking/ranking.module.js';
import { XpModule } from '../xp/xp.module.js';
import { BattleProcessor } from './battle.processor.js';
import { BATTLE_QUEUE, BattleQueue } from './battle.queue.js';
import { BattleFinishService } from './battle-finish.service.js';
import { BattleResultsService } from './battle-results.service.js';
import { BattlesController } from './battles.controller.js';
import { LobbyService } from './lobby.service.js';
import { MatchQueue } from './match-queue.js';
import { MatchmakingController } from './matchmaking.controller.js';
import { MatchmakingService } from './matchmaking.service.js';
import { PlayService } from './play.service.js';
import { ClassRoomsController, RoomsController } from './rooms.controller.js';
import { RoomsService } from './rooms.service.js';

@Module({
  imports: [
    BullModule.registerQueue({ name: BATTLE_QUEUE }),
    BadgesModule,
    NotificationsModule,
    PacksModule,
    XpModule,
    RankingModule,
  ],
  controllers: [BattlesController, MatchmakingController, RoomsController, ClassRoomsController],
  providers: [
    BattleFinishService,
    BattleResultsService,
    RoomsService,
    LobbyService,
    MatchQueue,
    MatchmakingService,
    PlayService,
    BattleQueue,
    BattleProcessor,
  ],
  exports: [RoomsService],
})
export class BattlesModule {}
