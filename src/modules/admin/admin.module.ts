import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BadgesModule } from '../badges/badges.module.js';
import { ClassesModule } from '../classes/classes.module.js';
import { ForbiddenWordsModule } from '../forbidden-words/forbidden-words.module.js';
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
import { AdminNoticesController } from './admin-notices.controller.js';
import { AdminPoliciesController } from './admin-policies.controller.js';
import { AdminPoliciesService } from './admin-policies.service.js';
import { AdminReportsController } from './admin-reports.controller.js';
import { AdminReportsService } from './admin-reports.service.js';
import { AdminSanctionsController } from './admin-sanctions.controller.js';
import { AdminSanctionsService } from './admin-sanctions.service.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminUsersService } from './admin-users.service.js';

@Module({
  imports: [
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
    AdminNoticesController,
    AdminPoliciesController,
    AdminReportsController,
    AdminSanctionsController,
    AdminUsersController,
  ],
  providers: [
    AdminAuditLogsService,
    AdminForbiddenWordsService,
    AdminPoliciesService,
    AdminReportsService,
    AdminSanctionsService,
    AdminUsersService,
  ],
})
export class AdminModule {}
