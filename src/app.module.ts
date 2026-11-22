import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from './common/common.module.js';
import { validateEnv } from './config/env.js';
import { InfraModule } from './infra/infra.module.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AppStatusModule } from './modules/app-status/app-status.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BadgesModule } from './modules/badges/badges.module.js';
import { BattlesModule } from './modules/battles/battles.module.js';
import { BlocksModule } from './modules/blocks/blocks.module.js';
import { ChallengesModule } from './modules/challenges/challenges.module.js';
import { ClassesModule } from './modules/classes/classes.module.js';
import { DataGsmSyncModule } from './modules/datagsm-sync/datagsm-sync.module.js';
import { DevicesModule } from './modules/devices/devices.module.js';
import { FriendsModule } from './modules/friends/friends.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { HomeModule } from './modules/home/home.module.js';
import { JobsModule } from './modules/jobs/jobs.module.js';
import { MaintenanceModule } from './modules/maintenance/maintenance.module.js';
import { MissionsModule } from './modules/missions/missions.module.js';
import { MorningModule } from './modules/morning/morning.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { PacksModule } from './modules/packs/packs.module.js';
import { PoliciesModule } from './modules/policies/policies.module.js';
import { PracticeModule } from './modules/practice/practice.module.js';
import { RankingModule } from './modules/ranking/ranking.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { RecordsModule } from './modules/records/records.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { ScheduledNotificationsModule } from './modules/scheduled-notifications/scheduled-notifications.module.js';
import { StudyModule } from './modules/study/study.module.js';
import { SupportModule } from './modules/support/support.module.js';
import { SuspiciousModule } from './modules/suspicious/suspicious.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { WordsModule } from './modules/words/words.module.js';
import { WrongNotesModule } from './modules/wrong-notes/wrong-notes.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: ['.env.local', '.env'],
      validate: validateEnv,
    }),
    InfraModule,
    CommonModule,
    HealthModule,
    AppStatusModule,
    AuthModule,
    DevicesModule,
    ClassesModule,
    PacksModule,
    WordsModule,
    StudyModule,
    WrongNotesModule,
    RecordsModule,
    MaintenanceModule,
    DataGsmSyncModule,
    RankingModule,
    HomeModule,
    RealtimeModule,
    BattlesModule,
    PracticeModule,
    ChallengesModule,
    NotificationsModule,
    FriendsModule,
    BlocksModule,
    ReportsModule,
    MorningModule,
    MissionsModule,
    BadgesModule,
    ScheduledNotificationsModule,
    AdminModule,
    JobsModule,
    SupportModule,
    SuspiciousModule,
    PoliciesModule,
    UsersModule,
  ],
})
export class AppModule {}
