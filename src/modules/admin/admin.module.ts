import { Module } from '@nestjs/common';
import { BadgesModule } from '../badges/badges.module.js';
import { ClassesModule } from '../classes/classes.module.js';
import { RankingModule } from '../ranking/ranking.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdminAuditLogsController } from './admin-audit-logs.controller.js';
import { AdminAuditLogsService } from './admin-audit-logs.service.js';
import { AdminUsersController } from './admin-users.controller.js';
import { AdminUsersService } from './admin-users.service.js';

@Module({
  imports: [BadgesModule, ClassesModule, RankingModule, UsersModule],
  controllers: [AdminAuditLogsController, AdminUsersController],
  providers: [AdminAuditLogsService, AdminUsersService],
})
export class AdminModule {}
