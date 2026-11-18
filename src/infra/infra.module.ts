import { Module } from '@nestjs/common';
import { DbModule } from './db/db.module.js';
import { QueueModule } from './queue/queue.module.js';
import { ValkeyModule } from './valkey/valkey.module.js';

@Module({
  imports: [DbModule, ValkeyModule, QueueModule],
})
export class InfraModule {}
