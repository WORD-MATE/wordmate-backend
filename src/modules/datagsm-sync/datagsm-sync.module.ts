import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RankingModule } from '../ranking/ranking.module.js';
import { DATAGSM_SYNC_QUEUE, DataGsmSyncProcessor } from './datagsm-sync.processor.js';
import { DataGsmSyncService } from './datagsm-sync.service.js';

@Module({
  imports: [BullModule.registerQueue({ name: DATAGSM_SYNC_QUEUE }), AuthModule, RankingModule],
  providers: [DataGsmSyncService, DataGsmSyncProcessor],
})
export class DataGsmSyncModule {}
