import { Controller, Get, HttpCode, Patch, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodBody, ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import {
  AdminSuspiciousPage,
  AdminSuspiciousQuery,
  ReviewSuspicious,
} from './admin-suspicious.schemas.js';
import { AdminSuspiciousService } from './admin-suspicious.service.js';

@ApiTags('admin')
@Auth('ADMIN')
@Controller('admin/suspicious-users')
export class AdminSuspiciousController {
  constructor(private readonly suspicious: AdminSuspiciousService) {}

  @ApiOperation({
    summary: '부정 의심 사용자 목록',
    description:
      '사용자·활동한 날(KST)별 묶음, 최근 날짜부터. 매일 04:30에 전날 활동을 감지해 표시만 하고 제재는 관리자가 정한다',
  })
  @Get()
  @ZodResponse(AdminSuspiciousPage)
  list(@ZodQuery(AdminSuspiciousQuery) query: z.infer<typeof AdminSuspiciousQuery>) {
    return this.suspicious.list(query);
  }

  @ApiOperation({
    summary: '부정 의심 확인 처리',
    description:
      '그날 그 사용자의 표시를 모두 확인함(또는 취소)으로 바꾼다. 404 SUSPICIOUS_NOT_FOUND',
  })
  @Patch(':userId/:date')
  @HttpCode(204)
  async review(
    @ZodParam('userId', z.uuid()) userId: string,
    @ZodParam('date', z.iso.date()) date: string,
    @ZodBody(ReviewSuspicious) body: z.infer<typeof ReviewSuspicious>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.suspicious.review(request.user as AuthUser, userId, date, body, request);
  }
}
