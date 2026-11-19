import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module.js';
import { ClassesController, TeachersController } from './classes.controller.js';
import { ClassesService } from './classes.service.js';

@Module({
  imports: [UsersModule],
  controllers: [ClassesController, TeachersController],
  providers: [ClassesService],
})
export class ClassesModule {}
