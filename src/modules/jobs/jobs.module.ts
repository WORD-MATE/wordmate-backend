import { Global, Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { JobRunsService } from './job-runs.service.js';

/** 여러 모듈의 작업 처리기가 실행 기록을 남기므로 전역으로 둔다 */
@Global()
@Module({
  imports: [NotificationsModule],
  providers: [JobRunsService],
  exports: [JobRunsService],
})
export class JobsModule {}
