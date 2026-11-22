import { Module } from '@nestjs/common';
import { FriendsModule } from '../friends/friends.module.js';
import { BlocksController } from './blocks.controller.js';
import { BlocksService } from './blocks.service.js';

@Module({
  imports: [FriendsModule],
  controllers: [BlocksController],
  providers: [BlocksService],
})
export class BlocksModule {}
