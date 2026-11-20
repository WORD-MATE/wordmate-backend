import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AppConfigService } from '../../common/app-config/app-config.service.js';
import { Auth } from '../../common/auth/auth.decorator.js';
import { SkipClientCheck } from '../../common/client/client.decorators.js';
import { compareVersions, isValidVersion } from '../../common/client/version.js';
import { PLATFORM, UPDATE_STATUS, type UpdateStatus } from '../../common/enums.js';
import { ZodQuery, ZodResponse } from '../../common/zod/decorators.js';

const AppStatusQuery = z.object({
  platform: z.enum(PLATFORM),
  version: z.string().refine(isValidVersion, '버전 형식이 올바르지 않습니다.'),
});

const AppStatus = z
  .object({
    maintenance: z.object({
      active: z.boolean(),
      message: z.string().nullable(),
      endsAt: z.iso.datetime().nullable(),
    }),
    update: z.object({
      status: z.enum(UPDATE_STATUS),
      minVersion: z.string().nullable(),
      latestVersion: z.string().nullable(),
      storeUrl: z.string().nullable(),
    }),
    serverTime: z.iso.datetime(),
  })
  .meta({ id: 'AppStatus' });

@ApiTags('app')
@Auth('ALL')
@SkipClientCheck()
@Controller('app')
export class AppStatusController {
  constructor(private readonly appConfig: AppConfigService) {}

  @ApiOperation({
    summary: '점검·업데이트 상태와 서버 시각',
    description: '앱 시작 시 가장 먼저 호출. 점검 중에도 200',
  })
  @Get('status')
  @ZodResponse(AppStatus)
  async status(@ZodQuery(AppStatusQuery) query: z.infer<typeof AppStatusQuery>) {
    const config = await this.appConfig.get();
    const minVersion = config.minVersion[query.platform] ?? null;
    const latestVersion = config.latestVersion[query.platform] ?? null;

    let status: UpdateStatus = 'NONE';
    if (minVersion && compareVersions(query.version, minVersion) < 0) status = 'REQUIRED';
    else if (latestVersion && compareVersions(query.version, latestVersion) < 0) {
      status = 'RECOMMENDED';
    }

    return {
      maintenance: {
        active: config.maintenance.enabled,
        message: config.maintenance.enabled ? config.maintenance.message || null : null,
        endsAt: config.maintenance.enabled ? config.maintenance.endsAt : null,
      },
      update: {
        status,
        minVersion,
        latestVersion,
        storeUrl: query.platform === 'WEB' ? null : (config.storeUrl[query.platform] ?? null),
      },
      serverTime: new Date().toISOString(),
    };
  }
}
