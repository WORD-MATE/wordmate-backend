import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { ClassDashboardService } from './class-dashboard.service.js';
import {
  ClassDashboardController,
  ClassesController,
  TeachersController,
} from './classes.controller.js';
import { ClassesService } from './classes.service.js';

@Module({
  imports: [UsersModule],
  controllers: [ClassesController, ClassDashboardController, TeachersController],
  providers: [ClassesService, ClassDashboardService],
  exports: [ClassesService],
})
export class ClassesModule {}
