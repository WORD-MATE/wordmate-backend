import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PacksModule } from '../packs/packs.module.js';
import { RankingModule } from '../ranking/ranking.module.js';
import { XpModule } from '../xp/xp.module.js';
import { BattleProcessor } from './battle.processor.js';
import { BATTLE_QUEUE, BattleQueue } from './battle.queue.js';
import { BattleFinishService } from './battle-finish.service.js';
import { BattleResultsService } from './battle-results.service.js';
import { BattlesController } from './battles.controller.js';
import { LobbyService } from './lobby.service.js';
import { PlayService } from './play.service.js';
import { ClassRoomsController, RoomsController } from './rooms.controller.js';
import { RoomsService } from './rooms.service.js';

@Module({
  imports: [BullModule.registerQueue({ name: BATTLE_QUEUE }), PacksModule, XpModule, RankingModule],
  controllers: [BattlesController, RoomsController, ClassRoomsController],
  providers: [
    BattleFinishService,
    BattleResultsService,
    RoomsService,
    LobbyService,
    PlayService,
    BattleQueue,
    BattleProcessor,
  ],
  exports: [RoomsService],
})
export class BattlesModule {}
