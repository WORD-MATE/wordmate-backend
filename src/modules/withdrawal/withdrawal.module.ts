import { Module } from '@nestjs/common';
import { BattlesModule } from '../battles/battles.module.js';
import { RankingModule } from '../ranking/ranking.module.js';
import { SupportModule } from '../support/support.module.js';
import { WithdrawalController } from './withdrawal.controller.js';
import { WithdrawalService } from './withdrawal.service.js';

@Module({
  imports: [BattlesModule, RankingModule, SupportModule],
  controllers: [WithdrawalController],
  providers: [WithdrawalService],
})
export class WithdrawalModule {}
