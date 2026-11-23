import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import { ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import { AuditLogPage, AuditLogQuery } from './admin-audit-logs.schemas.js';
import { AdminAuditLogsService } from './admin-audit-logs.service.js';

@ApiTags('admin')
@Auth('ADMIN')
@Controller('admin/audit-logs')
export class AdminAuditLogsController {
  constructor(private readonly auditLogs: AdminAuditLogsService) {}

  @ApiOperation({
    summary: '감사 로그',
    description: '관리자 행동과 교사 담당 반 변경 기록. 최신순, 기간은 KST 날짜(양 끝 포함)',
  })
  @Get()
  @ZodResponse(AuditLogPage)
  list(@ZodQuery(AuditLogQuery) query: z.infer<typeof AuditLogQuery>) {
    return this.auditLogs.list(query);
  }
}
