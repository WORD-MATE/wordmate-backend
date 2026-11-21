import { Controller, Get, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodResponse } from '../../common/zod/decorators.js';
import { Home } from './home.schemas.js';
import { HomeService, RECOMMENDED_PACK_COUNT } from './home.service.js';

@ApiTags('home')
@Controller('home')
export class HomeController {
  constructor(private readonly home: HomeService) {}

  @ApiOperation({
    summary: '홈 화면',
    description: `복습 수, 이어할 학습, 스트릭, 이번 주 학교 순위, 추천 단어팩(학습 기록이 없을 때 ${RECOMMENDED_PACK_COUNT}개)을 한 번에. 한 칸을 불러오지 못해도 나머지는 내려줌(그 칸은 null). 오늘의 문장·미션은 기능이 생기기 전까지 null`,
  })
  @Get()
  @ZodResponse(Home)
  get(@Req() request: FastifyRequest) {
    return this.home.home(request.user as AuthUser);
  }
}
