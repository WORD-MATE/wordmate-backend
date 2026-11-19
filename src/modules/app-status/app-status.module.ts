import { Module } from '@nestjs/common';
import { AppStatusController } from './app-status.controller.js';

@Module({ controllers: [AppStatusController] })
export class AppStatusModule {}
