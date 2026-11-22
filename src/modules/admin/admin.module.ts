import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BadgesModule } from '../badges/badges.module.js';
import { ClassesModule } from '../classes/classes.module.js';
import { ForbiddenWordsModule } from '../forbidden-words/forbidden-words.module.js';
import { JOB_QUEUES } from '../jobs/job-registry.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PoliciesModule } from '../policies/policies.module.js';
import { RankingModule } from '../ranking/ranking.module.js';
import { SupportModule } from '../support/support.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdminAppConfigController } from './admin-app-config.controller.js';
import { AdminAuditLogsController } from './admin-audit-logs.controller.js';
import { AdminAuditLogsService } from './admin-audit-logs.service.js';
import { AdminFaqsController } from './admin-faqs.controller.js';
import { AdminForbiddenWordsController } from './admin-forbidden-words.controller.js';
import { AdminForbiddenWordsService } from './admin-forbidden-words.service.js';
import { AdminJobsController } from './admin-jobs.controller.js';
import { AdminJobsService } from './admin-jobs.service.js';
import { AdminMorningController } from './admin-morning.controller.js';
import { AdminMorningService } from './admin-morning.service.js';
import { AdminNoticesController } from './admin-notices.controller.js';
import { AdminPoliciesController } from './admin-policies.controller.js';
import { AdminPoliciesService } from './admin-policies.service.js';
import { AdminReportsController } from './admin-reports.controller.js';
import { AdminReportsService } from './admin-reports.service.js';
import { AdminSanctionsController } from './admin-sanctions.controller.js';
import { AdminSanctionsService } from './admin-sanctions.service.js';
import { AdminSeasonsController } from './admin-seasons.controller.js';
import { AdminSeasonsService } from './admin-seasons.service.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminUsersService } from './admin-users.service.js';

@Module({
  imports: [
    // 관리자가 정기 작업을 직접 넣을 큐들
    ...JOB_QUEUES.map((name) => BullModule.registerQueue({ name })),
    AuthModule,
    BadgesModule,
    ClassesModule,
    ForbiddenWordsModule,
    NotificationsModule,
    PoliciesModule,
    RankingModule,
    SupportModule,
    UsersModule,
  ],
  controllers: [
    AdminAppConfigController,
    AdminAuditLogsController,
    AdminFaqsController,
    AdminForbiddenWordsController,
    AdminJobsController,
    AdminMorningController,
    AdminNoticesController,
    AdminPoliciesController,
    AdminReportsController,
    AdminSanctionsController,
    AdminSeasonsController,
    AdminUsersController,
  ],
  providers: [
    AdminAuditLogsService,
    AdminForbiddenWordsService,
    AdminJobsService,
    AdminMorningService,
    AdminPoliciesService,
    AdminReportsService,
    AdminSanctionsService,
    AdminSeasonsService,
    AdminUsersService,
  ],
})
export class AdminModule {}
