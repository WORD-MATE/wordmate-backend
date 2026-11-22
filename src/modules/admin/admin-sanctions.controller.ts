import { Controller, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Idempotent } from '../../common/idempotency/idempotent.decorator.js';
import { ZodBody, ZodResponse } from '../../common/zod/decorators.js';
import { ApplySanction, SanctionCreated } from './admin-sanctions.schemas.js';
import { AdminSanctionsService } from './admin-sanctions.service.js';

@ApiTags('admin')
@Auth('ADMIN')
@Controller('admin/sanctions')
export class AdminSanctionsController {
  constructor(private readonly sanctions: AdminSanctionsService) {}

  @ApiOperation({
    summary: '제재',
    description:
      'WARNING·XP_REVOKE(가진 만큼만 회수)는 SANCTION 알림, SUSPEND(기간 필수)·BAN은 계정 정지와 모든 세션 폐기(사유는 로그인 때 안내). 409 ADMIN_SELF_ACTION, 404 USER_NOT_FOUND',
  })
  @Post()
  @Idempotent()
  @ZodResponse(SanctionCreated, { status: 201 })
  apply(
    @ZodBody(ApplySanction) body: z.infer<typeof ApplySanction>,
    @Req() request: FastifyRequest,
  ) {
    return this.sanctions.apply(request.user as AuthUser, body, request);
  }
}
