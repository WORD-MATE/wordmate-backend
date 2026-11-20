import { Module } from '@nestjs/common';
import { XpService } from './xp.service.js';

@Module({
  providers: [XpService],
  exports: [XpService],
})
export class XpModule {}
