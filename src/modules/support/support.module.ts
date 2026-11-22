import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { FaqsController } from './faqs.controller.js';
import { FaqsService } from './faqs.service.js';
import { InquiriesController, InquiryImagesController } from './inquiries.controller.js';
import { InquiriesService } from './inquiries.service.js';
import { InquiryImageStorage, uploadRootProvider } from './inquiry-image.storage.js';
import { NoticesController } from './notices.controller.js';
import { NoticesService } from './notices.service.js';

@Module({
  imports: [NotificationsModule],
  controllers: [FaqsController, InquiriesController, InquiryImagesController, NoticesController],
  providers: [
    FaqsService,
    InquiriesService,
    InquiryImageStorage,
    NoticesService,
    uploadRootProvider,
  ],
  exports: [FaqsService, InquiriesService, NoticesService],
})
export class SupportModule {}
