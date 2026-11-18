import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { SkipTermsCheck } from '../../common/auth/terms.decorator.js';
import { ZodBody, ZodResponse } from '../../common/zod/decorators.js';
import { AgreementService } from './agreement.service.js';
import { NextStepService } from './next-step.service.js';
import { AgreementStatus, NextStepResponse, SubmitAgreements } from './users.schemas.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;

@ApiTags('users')
@Auth('USER')
@Controller('users/me')
export class UsersController {
  constructor(
    private readonly agreements: AgreementService,
    private readonly nextStep: NextStepService,
  ) {}

  @ApiOperation({ summary: '약관 동의 현황', description: '약관 동의 전에도 호출할 수 있음' })
  @SkipTermsCheck()
  @Get('agreements')
  @ZodResponse(AgreementStatus)
  agreementStatus(@Req() request: FastifyRequest) {
    return this.agreements.status(currentUser(request).userId);
  }

  @ApiOperation({
    summary: '약관 동의 제출',
    description: '동의 이력을 저장하고 다음 단계를 돌려줌',
  })
  @SkipTermsCheck()
  @Post('agreements')
  @HttpCode(200)
  @ZodResponse(NextStepResponse)
  async submitAgreements(
    @ZodBody(SubmitAgreements) body: z.infer<typeof SubmitAgreements>,
    @Req() request: FastifyRequest,
  ) {
    const { userId } = currentUser(request);
    await this.agreements.submit(userId, body.items);
    return { nextStep: await this.nextStep.resolve(userId) };
  }
}
