import { Module } from '@nestjs/common';
import { MissionsModule } from '../missions/missions.module.js';
import { MorningModule } from '../morning/morning.module.js';
import { PacksModule } from '../packs/packs.module.js';
import { RankingModule } from '../ranking/ranking.module.js';
import { RecordsModule } from '../records/records.module.js';
import { StudyModule } from '../study/study.module.js';
import { HomeController } from './home.controller.js';
import { HomeService } from './home.service.js';

@Module({
  imports: [MissionsModule, MorningModule, PacksModule, RankingModule, RecordsModule, StudyModule],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
