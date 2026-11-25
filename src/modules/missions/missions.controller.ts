import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ZodParam, ZodResponse } from '../../common/zod/decorators.js';
import { MissionClaimResult, MissionList } from './missions.schemas.js';
import { MissionsService } from './missions.service.js';

@ApiTags('missions')
@Auth('STUDENT')
@Controller('missions')
export class MissionsController {
  constructor(private readonly missions: MissionsService) {}

  @ApiOperation({
    summary: '일일·주간 미션',
    description: '일일은 KST 자정, 주간은 월요일 KST 자정에 새로 셈',
  })
  @Get()
  @ZodResponse(MissionList)
  list(@CurrentUser() user: AuthUser) {
    return this.missions.list(user);
  }

  @ApiOperation({
    summary: '미션 보상 받기',
    description:
      '이번 기간에 한 번. XP 출처 MISSION, 하루 500 상한 포함(일부만 받아도 받은 것으로 끝). 404 MISSION_NOT_FOUND, 409 MISSION_NOT_CLAIMABLE / MISSION_ALREADY_CLAIMED',
  })
  @Post(':missionId/claim')
  @HttpCode(200)
  @ZodResponse(MissionClaimResult)
  claim(@ZodParam('missionId', z.uuid()) missionId: string, @CurrentUser() user: AuthUser) {
    return this.missions.claim(user, missionId);
  }
}
