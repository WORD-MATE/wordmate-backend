import { Controller, Get, HttpCode, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodBody, ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import {
  AdminSeasonDetail,
  AdminSeasonPage,
  AdminSeasonQuery,
  SeasonRerunQueued,
  UpdateSeasonExclusions,
} from './admin-seasons.schemas.js';
import { AdminSeasonsService } from './admin-seasons.service.js';

const SeasonIdParam = () => ZodParam('seasonId', z.uuid());

@ApiTags('admin')
@Auth('ADMIN')
@Controller('admin/seasons')
export class AdminSeasonsController {
  constructor(private readonly seasons: AdminSeasonsService) {}

  @ApiOperation({
    summary: '시즌 목록',
    description: '최근 시즌부터. 시즌은 기간이 끝나면 자동으로 마감·확정된다 (확정 API 없음)',
  })
  @Get()
  @ZodResponse(AdminSeasonPage)
  list(@ZodQuery(AdminSeasonQuery) query: z.infer<typeof AdminSeasonQuery>) {
    return this.seasons.list(query);
  }

  @ApiOperation({
    summary: '시즌 상세',
    description:
      '학교 범위 상위 100위(제외 표시), 제외 대상, 실패 사유. 404 ADMIN_SEASON_NOT_FOUND',
  })
  @Get(':seasonId')
  @ZodResponse(AdminSeasonDetail)
  detail(@SeasonIdParam() seasonId: string) {
    return this.seasons.detail(seasonId);
  }

  @ApiOperation({
    summary: '시즌 제외 대상 지정 (전체 교체)',
    description:
      '제외된 사용자는 그 시즌 모든 범위(학교·학년·반) 순위에서 빠지고 나머지 순위를 다시 매긴다. 마감을 다시 돌려도 다시 적용된다. 404 ADMIN_SEASON_NOT_FOUND / USER_NOT_FOUND',
  })
  @Put(':seasonId/exclusions')
  @HttpCode(204)
  async updateExclusions(
    @SeasonIdParam() seasonId: string,
    @ZodBody(UpdateSeasonExclusions) body: z.infer<typeof UpdateSeasonExclusions>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.seasons.updateExclusions(request.user as AuthUser, seasonId, body, request);
  }

  @ApiOperation({
    summary: '실패한 시즌 마감 다시 실행',
    description:
      '큐에 넣고 바로 202. 진행은 GET /admin/jobs의 SEASON_CLOSE. 404 ADMIN_SEASON_NOT_FOUND / 409 ADMIN_SEASON_NOT_FAILED',
  })
  @Post(':seasonId/rerun')
  @HttpCode(202)
  @ZodResponse(SeasonRerunQueued, { status: 202 })
  rerun(@SeasonIdParam() seasonId: string, @Req() request: FastifyRequest) {
    return this.seasons.rerun(request.user as AuthUser, seasonId, request);
  }
}
