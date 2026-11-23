import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import {
  SCHEDULED_NOTIFICATIONS_QUEUE,
  ScheduledNotificationsProcessor,
} from './scheduled-notifications.processor.js';
import { ScheduledNotificationsService } from './scheduled-notifications.service.js';

@Module({
  imports: [BullModule.registerQueue({ name: SCHEDULED_NOTIFICATIONS_QUEUE }), NotificationsModule],
  providers: [ScheduledNotificationsService, ScheduledNotificationsProcessor],
  exports: [ScheduledNotificationsService],
})
export class ScheduledNotificationsModule {}
