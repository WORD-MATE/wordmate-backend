import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { CommonModule } from './common/common.module.js';
import { validateEnv } from './config/env.js';
import { InfraModule } from './infra/infra.module.js';
import { AppStatusModule } from './modules/app-status/app-status.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BattlesModule } from './modules/battles/battles.module.js';
import { ClassesModule } from './modules/classes/classes.module.js';
import { DevicesModule } from './modules/devices/devices.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { HomeModule } from './modules/home/home.module.js';
import { MaintenanceModule } from './modules/maintenance/maintenance.module.js';
import { PacksModule } from './modules/packs/packs.module.js';
import { PoliciesModule } from './modules/policies/policies.module.js';
import { RankingModule } from './modules/ranking/ranking.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { RecordsModule } from './modules/records/records.module.js';
import { StudyModule } from './modules/study/study.module.js';
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
    RankingModule,
    HomeModule,
    RealtimeModule,
    BattlesModule,
    PoliciesModule,
    UsersModule,
  ],
})
export class AppModule {}
