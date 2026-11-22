import { Module } from '@nestjs/common';
import { PacksModule } from '../packs/packs.module.js';
import { RankingModule } from '../ranking/ranking.module.js';
import { WordsModule } from '../words/words.module.js';
import { XpModule } from '../xp/xp.module.js';
import { MorningController } from './morning.controller.js';
import { MorningService } from './morning.service.js';

@Module({
  imports: [PacksModule, WordsModule, XpModule, RankingModule],
  controllers: [MorningController],
  providers: [MorningService],
  exports: [MorningService],
})
export class MorningModule {}
