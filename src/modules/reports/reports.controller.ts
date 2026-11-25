import { Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ZodBody, ZodResponse } from '../../common/zod/decorators.js';
import { CreateReport, ReportCreated } from './reports.schemas.js';
import { ReportsService } from './reports.service.js';

@ApiTags('reports')
@Auth('USER')
@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @ApiOperation({
    summary: '신고',
    description:
      '사용자·단어팩·단어. 기타(OTHER)는 상세 필수(200자 이하). 400 REPORT_SELF(나·내 단어팩), 404 REPORT_TARGET_NOT_FOUND / BATTLE_NOT_FOUND(참여하지 않은 대결), 429 REPORT_DUPLICATE_TODAY(같은 대상·사유 하루 한 번, KST)',
  })
  @Post()
  @ZodResponse(ReportCreated, { status: 201 })
  create(@ZodBody(CreateReport) body: CreateReport, @CurrentUser() user: AuthUser) {
    return this.reports.create(user, body);
  }
}
