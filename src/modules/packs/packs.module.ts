import { Module } from '@nestjs/common';
import { ForbiddenWordsModule } from '../forbidden-words/forbidden-words.module.js';
import { PacksController } from './packs.controller.js';
import { PacksService } from './packs.service.js';

@Module({
  imports: [ForbiddenWordsModule],
  controllers: [PacksController],
  providers: [PacksService],
  exports: [PacksService],
})
export class PacksModule {}
