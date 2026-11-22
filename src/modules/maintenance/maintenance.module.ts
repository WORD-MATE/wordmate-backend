import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { SupportModule } from '../support/support.module.js';
import { MAINTENANCE_QUEUE, MaintenanceProcessor } from './maintenance.processor.js';
import { MaintenanceService } from './maintenance.service.js';

@Module({
  imports: [BullModule.registerQueue({ name: MAINTENANCE_QUEUE }), SupportModule],
  providers: [MaintenanceService, MaintenanceProcessor],
})
export class MaintenanceModule {}
