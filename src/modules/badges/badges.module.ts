import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { BadgesController } from './badges.controller.js';
import { BadgesService } from './badges.service.js';

@Module({
  imports: [NotificationsModule],
  controllers: [BadgesController],
  providers: [BadgesService],
  exports: [BadgesService],
})
export class BadgesModule {}
