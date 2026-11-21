import { Controller, Delete, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodResponse } from '../../common/zod/decorators.js';
import { MatchmakingService } from './matchmaking.service.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;

const MatchTicket = z
  .object({
    queuedAt: z.iso.datetime(),
    timeoutAt: z.iso.datetime().describe('이때까지 상대가 없으면 MATCH_TIMEOUT'),
  })
  .meta({ id: 'MatchTicket' });

@ApiTags('battles')
@Controller('battles/matchmaking')
export class MatchmakingController {
  constructor(private readonly matchmaking: MatchmakingService) {}

  @ApiOperation({
    summary: '빠른 1:1 매칭',
    description:
      'WebSocket 접속 필수(409 MATCH_WS_NOT_CONNECTED). 대기 중인 사람 가운데 누적 XP가 가장 가까운 상대와 짝짓는다. 결과는 WebSocket MATCH_FOUND { roomId, inviteCode }(바로 카운트다운 시작) 또는 60초 뒤 MATCH_TIMEOUT. 기본 단어팩·한→영 4지선다·10문항·10초. 409 ROOM_ALREADY_JOINED / MATCH_ALREADY_QUEUED',
  })
  @Auth('STUDENT')
  @Post()
  @HttpCode(202)
  @ZodResponse(MatchTicket, { status: 202 })
  enqueue(@Req() request: FastifyRequest) {
    return this.matchmaking.enqueue(currentUser(request));
  }

  @ApiOperation({
    summary: '매칭 취소',
    description:
      '성사와 겹치면 서버에 먼저 도착한 요청 기준. 이미 성사됐으면 409 MATCH_ALREADY_FOUND(detail = { roomId, inviteCode } → 대기실로), 기다리는 매칭이 없으면 404 MATCH_NOT_QUEUED',
  })
  @Auth('STUDENT')
  @Delete()
  @HttpCode(204)
  async cancel(@Req() request: FastifyRequest): Promise<void> {
    await this.matchmaking.cancel(currentUser(request));
  }
}
