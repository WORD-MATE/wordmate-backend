import { Module } from '@nestjs/common';
import { RecordsController, StatsController } from './records.controller.js';
import { RecordsService } from './records.service.js';

@Module({
  controllers: [RecordsController, StatsController],
  providers: [RecordsService],
})
export class RecordsModule {}
