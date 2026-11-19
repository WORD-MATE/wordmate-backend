import { Module } from '@nestjs/common';
import { ForbiddenWordsModule } from '../forbidden-words/forbidden-words.module.js';
import { PacksModule } from '../packs/packs.module.js';
import { WordsController } from './words.controller.js';
import { WordsService } from './words.service.js';

@Module({
  imports: [PacksModule, ForbiddenWordsModule],
  controllers: [WordsController],
  providers: [WordsService],
})
export class WordsModule {}
