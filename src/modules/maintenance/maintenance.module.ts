import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { MAINTENANCE_QUEUE, MaintenanceProcessor } from './maintenance.processor.js';
import { MaintenanceService } from './maintenance.service.js';

@Module({
  imports: [BullModule.registerQueue({ name: MAINTENANCE_QUEUE })],
  providers: [MaintenanceService, MaintenanceProcessor],
})
export class MaintenanceModule {}
