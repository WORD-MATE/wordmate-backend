import { Controller, Get, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import { MyRanking, MyRankingQuery, RankingPage, RankingQuery } from './ranking.schemas.js';
import { CLASS_MIN_PARTICIPANTS, RankingQueryService, TOP_LIMIT } from './ranking-query.service.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;

@ApiTags('ranking')
@Controller('ranking')
export class RankingController {
  constructor(private readonly ranking: RankingQueryService) {}

  @ApiOperation({
    summary: '랭킹 목록',
    description: `학생만 집계(교사 제외), 랭킹 비공개·정지·탈퇴 사용자는 빠짐. 상위 ${TOP_LIMIT}명까지, 5분마다 다시 계산(updatedAt). XP가 같으면 먼저 도달한 사용자가 위. GRADE·CLASS는 내 학년·반 기준(교사는 SCHOOL만). 반 랭킹은 참여 인원이 ${CLASS_MIN_PARTICIPANTS}명 미만이면 available=false. 주간은 월요일 00:00, 월간은 1일 00:00(KST)에 새로 시작`,
  })
  @Get()
  @ZodResponse(RankingPage)
  list(
    @ZodQuery(RankingQuery) query: z.infer<typeof RankingQuery>,
    @Req() request: FastifyRequest,
  ) {
    return this.ranking.list(currentUser(request), query);
  }

  @ApiOperation({
    summary: '내 순위',
    description: `비공개여도 본인 순위는 볼 수 있음(공개 사용자 사이에 끼워 계산). 지금 값 기준. ${TOP_LIMIT}위 밖이면 rank 대신 topPercent, XP가 0이면 rank·topPercent 모두 null. change는 지난 기간 대비 순위 변동(양수면 상승)`,
  })
  @Auth('STUDENT')
  @Get('me')
  @ZodResponse(MyRanking)
  me(
    @ZodQuery(MyRankingQuery) query: z.infer<typeof MyRankingQuery>,
    @Req() request: FastifyRequest,
  ) {
    return this.ranking.me(currentUser(request), query);
  }
}
