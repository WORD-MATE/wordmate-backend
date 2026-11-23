import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodResponse } from '../../common/zod/decorators.js';
import { WS_PATH } from './realtime.gateway.js';
import { RealtimeService, TICKET_TTL_SECONDS } from './realtime.service.js';

const RealtimeTicket = z
  .object({
    ticket: z.string(),
    expiresAt: z.iso.datetime(),
    wsUrl: z.string().describe('{wsUrl}?ticket={ticket} 으로 접속'),
  })
  .meta({ id: 'RealtimeTicket' });

@ApiTags('realtime')
@Controller('realtime')
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @ApiOperation({
    summary: 'WebSocket 접속 티켓',
    description: `1회용, ${TICKET_TTL_SECONDS}초. 다시 연결할 때마다 새로 받음. 메시지 형식 { type, requestId, payload } (서버 → 클라이언트는 serverTime 추가), 실패하면 ERROR { code, message }. 서버가 30초마다 ping을 보내고 답이 없으면 끊음`,
  })
  @Post('ticket')
  @HttpCode(200)
  @ZodResponse(RealtimeTicket)
  async ticket(@Req() request: FastifyRequest) {
    const { ticket, expiresAt } = await this.realtime.issueTicket(
      (request.user as AuthUser).userId,
    );
    // 프록시 뒤에서도 바깥 주소로 안내하도록 trustProxy가 반영된 protocol·host를 쓴다
    const scheme = request.protocol === 'https' ? 'wss' : 'ws';
    return {
      ticket,
      expiresAt: expiresAt.toISOString(),
      wsUrl: `${scheme}://${request.host}${WS_PATH}`,
    };
  }
}
