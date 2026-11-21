import { Module } from '@nestjs/common';
import { PacksModule } from '../packs/packs.module.js';
import { PracticeController } from './practice.controller.js';
import { PracticeService } from './practice.service.js';

@Module({
  imports: [PacksModule],
  controllers: [PracticeController],
  providers: [PracticeService],
})
export class PracticeModule {}
