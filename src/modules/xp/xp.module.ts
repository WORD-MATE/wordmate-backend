import { Module } from '@nestjs/common';
import { XpService } from './xp.service.js';
import { XpHistoryService } from './xp-history.service.js';

@Module({
  providers: [XpService, XpHistoryService],
  exports: [XpService, XpHistoryService],
})
export class XpModule {}
