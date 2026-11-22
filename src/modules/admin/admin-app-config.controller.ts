import { Controller, Get, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { AppConfig, AppConfigService } from '../../common/app-config/app-config.service.js';
import { AuditLogService } from '../../common/audit/audit-log.service.js';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodBody, ZodResponse } from '../../common/zod/decorators.js';
import { AdminAppConfig } from './admin-app-config.schemas.js';

@ApiTags('admin')
@Auth('ADMIN')
@Controller('admin/app-config')
export class AdminAppConfigController {
  constructor(
    private readonly config: AppConfigService,
    private readonly audit: AuditLogService,
  ) {}

  @ApiOperation({
    summary: '앱 설정 조회',
    description: '점검 모드·플랫폼별 최소·최신 버전·스토어 주소',
  })
  @Get()
  @ZodResponse(AppConfig)
  get() {
    return this.config.get(true);
  }

  @ApiOperation({
    summary: '앱 설정 변경',
    description:
      '전체 교체. 점검 중에도 관리자 API는 동작. 모든 서버에 5초 안에 반영. 400 VALIDATION_FAILED(버전 형식, 최소 > 최신)',
  })
  @Put()
  @ZodResponse(AppConfig)
  async put(
    @ZodBody(AdminAppConfig) body: z.infer<typeof AdminAppConfig>,
    @Req() request: FastifyRequest,
  ) {
    const before = await this.config.get(true);
    await this.config.set(body);
    await this.audit.record(
      {
        actorId: (request.user as AuthUser).userId,
        action: 'APP_CONFIG_CHANGE',
        targetType: 'APP_CONFIG',
        targetId: null,
        detail: { before, after: body },
      },
      request,
    );
    return this.config.get(true);
  }
}
