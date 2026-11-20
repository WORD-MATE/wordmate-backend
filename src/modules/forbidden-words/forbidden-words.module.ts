import { Module } from '@nestjs/common';
import { ForbiddenWordsService } from './forbidden-words.service.js';

@Module({
  providers: [ForbiddenWordsService],
  exports: [ForbiddenWordsService],
})
export class ForbiddenWordsModule {}
