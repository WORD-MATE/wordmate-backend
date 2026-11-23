import { Controller, Get, HttpCode, Patch, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodBody, ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import {
  AdminReportGroupDetail,
  AdminReportGroupPage,
  AdminReportQuery,
  UpdateReportGroup,
} from './admin-reports.schemas.js';
import { AdminReportsService } from './admin-reports.service.js';

const GroupIdParam = () => ZodParam('reportGroupId', z.uuid());

@ApiTags('admin')
@Auth('ADMIN')
@Controller('admin/reports')
export class AdminReportsController {
  constructor(private readonly reports: AdminReportsService) {}

  @ApiOperation({
    summary: '신고 목록 (대상별 묶음)',
    description: '최근에 신고가 들어온 묶음부터. 처리하면 묶음이 닫히고 그 뒤의 신고는 새 묶음',
  })
  @Get()
  @ZodResponse(AdminReportGroupPage)
  list(@ZodQuery(AdminReportQuery) query: z.infer<typeof AdminReportQuery>) {
    return this.reports.list(query);
  }

  @ApiOperation({
    summary: '신고 상세',
    description: '신고한 사람은 보여 주지 않음. 404 REPORT_NOT_FOUND',
  })
  @Get(':reportGroupId')
  @ZodResponse(AdminReportGroupDetail)
  detail(@GroupIdParam() groupId: string) {
    return this.reports.detail(groupId);
  }

  @ApiOperation({
    summary: '신고 처리',
    description:
      '완료(RESOLVED)는 결과·메모 필수. 처음 완료하면 신고한 사람들에게 REPORT_RESULT 알림. 완료 뒤에는 결과·메모만 수정(409 REPORT_ALREADY_RESOLVED), 바꿀 때마다 이력. 제재는 POST /admin/sanctions를 reportGroupId와 함께 따로 호출',
  })
  @Patch(':reportGroupId')
  @HttpCode(204)
  async update(
    @GroupIdParam() groupId: string,
    @ZodBody(UpdateReportGroup) body: z.infer<typeof UpdateReportGroup>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.reports.update(request.user as AuthUser, groupId, body, request);
  }
}
