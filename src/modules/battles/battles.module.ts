import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { PacksModule } from '../packs/packs.module.js';
import { BattleProcessor } from './battle.processor.js';
import { BATTLE_QUEUE, BattleQueue } from './battle.queue.js';
import { LobbyService } from './lobby.service.js';
import { ClassRoomsController, RoomsController } from './rooms.controller.js';
import { RoomsService } from './rooms.service.js';

@Module({
  imports: [BullModule.registerQueue({ name: BATTLE_QUEUE }), PacksModule],
  controllers: [RoomsController, ClassRoomsController],
  providers: [RoomsService, LobbyService, BattleQueue, BattleProcessor],
  exports: [RoomsService],
})
export class BattlesModule {}
