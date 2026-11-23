import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ApnsSender } from './apns.sender.js';
import { FcmSender } from './fcm.sender.js';
import { PushProcessor } from './push.processor.js';
import { PUSH_QUEUE, PushService } from './push.service.js';
import { WebPushSender } from './webpush.sender.js';

@Module({
  imports: [BullModule.registerQueue({ name: PUSH_QUEUE })],
  providers: [ApnsSender, FcmSender, WebPushSender, PushService, PushProcessor],
  exports: [PushService],
})
export class PushModule {}
