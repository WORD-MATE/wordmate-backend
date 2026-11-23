import { Controller, Delete, HttpCode, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { SkipTermsCheck } from '../../common/auth/onboarding.decorator.js';
import { ZodBody } from '../../common/zod/decorators.js';
import { WithdrawRequest } from './withdrawal.schemas.js';
import { WithdrawalErrors, WithdrawalService } from './withdrawal.service.js';

@ApiTags('users')
@Auth('USER')
@Controller('users/me')
export class WithdrawalController {
  constructor(private readonly withdrawal: WithdrawalService) {}

  @ApiOperation({
    summary: '회원 탈퇴',
    description:
      '유예 없이 바로 처리. 모든 기기 세션·푸시 등록과 DataGSM 연결을 끊고, 남은 액세스 토큰도 바로 막는다(이후 401 AUTH_INVALID). 개인정보·학습 기록·랭킹을 지우고 끝난 대결 결과에는 "탈퇴한 사용자"로 남는다. 같은 DataGSM 계정으로 다시 로그인하면 새 계정. 약관 동의·담당 반 선택 전에도 호출할 수 있음. 400 USER_WITHDRAW_NOT_CONFIRMED / 409 USER_LAST_ADMIN',
  })
  @SkipTermsCheck()
  @Delete()
  @HttpCode(204)
  async withdraw(
    @ZodBody(WithdrawRequest) body: z.infer<typeof WithdrawRequest>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    if (body?.confirm !== true) throw WithdrawalErrors.notConfirmed();
    await this.withdrawal.withdraw((request.user as AuthUser).userId);
  }
}
