import { Controller, Delete, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodBody, ZodParam, ZodResponse } from '../../common/zod/decorators.js';
import { BlockedUserList, BlockUser } from './blocks.schemas.js';
import { BlocksService } from './blocks.service.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;

@ApiTags('blocks')
@Auth('STUDENT')
@Controller('blocks')
export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  @ApiOperation({ summary: '차단 목록', description: '최근에 차단한 순' })
  @Get()
  @ZodResponse(BlockedUserList)
  list(@Req() request: FastifyRequest) {
    return this.blocks.list(currentUser(request));
  }

  @ApiOperation({
    summary: '차단',
    description:
      '친구 관계·대기 중인 친구 요청을 함께 지우고 상대에게 알리지 않음. 400 BLOCK_SELF, 403 BLOCK_NOT_ALLOWED(교사), 404 USER_NOT_FOUND, 409 BLOCK_ALREADY',
  })
  @Post()
  @HttpCode(204)
  async block(
    @ZodBody(BlockUser) body: z.infer<typeof BlockUser>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.blocks.block(currentUser(request), body.userId);
  }

  @ApiOperation({
    summary: '차단 해제',
    description: '친구 관계는 되살리지 않음. 404 BLOCK_NOT_FOUND',
  })
  @Delete(':userId')
  @HttpCode(204)
  async unblock(
    @ZodParam('userId', z.uuid()) userId: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.blocks.unblock(currentUser(request), userId);
  }
}
