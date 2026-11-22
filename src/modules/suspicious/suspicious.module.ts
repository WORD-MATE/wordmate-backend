import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { SUSPICIOUS_QUEUE, SuspiciousProcessor } from './suspicious.processor.js';
import { SuspiciousService } from './suspicious.service.js';

@Module({
  imports: [BullModule.registerQueue({ name: SUSPICIOUS_QUEUE })],
  providers: [SuspiciousService, SuspiciousProcessor],
  exports: [SuspiciousService],
})
export class SuspiciousModule {}
