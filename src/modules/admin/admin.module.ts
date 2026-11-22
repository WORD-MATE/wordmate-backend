import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BadgesModule } from '../badges/badges.module.js';
import { ClassesModule } from '../classes/classes.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { RankingModule } from '../ranking/ranking.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdminAuditLogsController } from './admin-audit-logs.controller.js';
import { AdminAuditLogsService } from './admin-audit-logs.service.js';
import { AdminSanctionsController } from './admin-sanctions.controller.js';
import { AdminSanctionsService } from './admin-sanctions.service.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminUsersService } from './admin-users.service.js';

@Module({
  imports: [
    AuthModule,
    BadgesModule,
    ClassesModule,
    NotificationsModule,
    RankingModule,
    UsersModule,
  ],
  controllers: [AdminAuditLogsController, AdminSanctionsController, AdminUsersController],
  providers: [AdminAuditLogsService, AdminSanctionsService, AdminUsersService],
})
export class AdminModule {}
