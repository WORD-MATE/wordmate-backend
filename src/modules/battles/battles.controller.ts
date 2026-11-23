import { Controller, Get, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import { BattleHistory, BattleHistoryQuery, BattleResult, Room } from './battle.schemas.js';
import { BattleResultsService } from './battle-results.service.js';
import { RoomsService } from './rooms.service.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;

@ApiTags('battles')
@Controller('battles')
export class BattlesController {
  constructor(
    private readonly results: BattleResultsService,
    private readonly rooms: RoomsService,
  ) {}

  @ApiOperation({
    summary: '대결 기록',
    description:
      '최신순 커서. 요약의 승률은 1위 횟수 / 완주한 대결 수, 평균 정답률은 완주한 대결만 (둘 다 0~1)',
  })
  @Auth('STUDENT')
  @Get('history')
  @ZodResponse(BattleHistory)
  history(
    @ZodQuery(BattleHistoryQuery) query: z.infer<typeof BattleHistoryQuery>,
    @Req() request: FastifyRequest,
  ) {
    return this.results.history(currentUser(request), query);
  }

  @ApiOperation({
    summary: '대결 결과',
    description:
      '순위(중도 이탈은 rank null, 맨 아래)·내 XP·문항별 내 답. 결과 화면과 기록의 읽기 전용 화면이 같이 쓴다. 참가자와 교사용 방 진행자만(403), 끝나지 않았으면 404 BATTLE_NOT_FOUND',
  })
  @Get(':battleId/result')
  @ZodResponse(BattleResult)
  result(@ZodParam('battleId', z.uuid()) battleId: string, @Req() request: FastifyRequest) {
    return this.results.result(currentUser(request), battleId);
  }

  @ApiOperation({
    summary: '다시 하기',
    description:
      '같은 설정으로 새 방, 요청한 사람이 방장. 교사용 방은 진행한 교사만(교사용 반 방으로). 다른 방에 있으면 409 ROOM_ALREADY_JOINED. 초대 알림은 알림 기능에서',
  })
  @Post(':battleId/rematch')
  @ZodResponse(Room, { status: 201 })
  rematch(@ZodParam('battleId', z.uuid()) battleId: string, @Req() request: FastifyRequest) {
    return this.rooms.rematch(currentUser(request), battleId);
  }
}
