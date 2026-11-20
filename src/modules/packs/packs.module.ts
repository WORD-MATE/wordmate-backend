import { Module } from '@nestjs/common';
import { ForbiddenWordsModule } from '../forbidden-words/forbidden-words.module.js';
import { PackShareController } from './pack-share.controller.js';
import { PackShareService } from './pack-share.service.js';
import { PacksController } from './packs.controller.js';
import { PacksService } from './packs.service.js';

@Module({
  imports: [ForbiddenWordsModule],
  controllers: [PacksController, PackShareController],
  providers: [PacksService, PackShareService],
  exports: [PacksService],
})
export class PacksModule {}
