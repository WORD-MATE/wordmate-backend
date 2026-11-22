import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { FaqsController } from './faqs.controller.js';
import { FaqsService } from './faqs.service.js';
import { NoticesController } from './notices.controller.js';
import { NoticesService } from './notices.service.js';

@Module({
  imports: [NotificationsModule],
  controllers: [FaqsController, NoticesController],
  providers: [FaqsService, NoticesService],
  exports: [FaqsService, NoticesService],
})
export class SupportModule {}
