import { Module } from '@nestjs/common';
import { ForbiddenWordsModule } from '../forbidden-words/forbidden-words.module.js';
import { PacksModule } from '../packs/packs.module.js';
import { WordFavoritesService } from './word-favorites.service.js';
import { WordLibraryController } from './word-library.controller.js';
import { WordSearchService } from './word-search.service.js';
import { WordViewerService } from './word-viewer.service.js';
import { WordsController } from './words.controller.js';
import { WordsService } from './words.service.js';

@Module({
  imports: [PacksModule, ForbiddenWordsModule],
  controllers: [WordsController, WordLibraryController],
  providers: [WordsService, WordSearchService, WordFavoritesService, WordViewerService],
  exports: [WordsService, WordViewerService],
})
export class WordsModule {}
