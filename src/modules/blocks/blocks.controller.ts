import { Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ZodBody, ZodParam, ZodResponse } from '../../common/zod/decorators.js';
import { BlockedUserList, BlockUser } from './blocks.schemas.js';
import { BlocksService } from './blocks.service.js';

@ApiTags('blocks')
@Auth('STUDENT')
@Controller('blocks')
export class BlocksController {
  constructor(private readonly blocks: BlocksService) {}

  @ApiOperation({ summary: '차단 목록', description: '최근에 차단한 순' })
  @Get()
  @ZodResponse(BlockedUserList)
  list(@CurrentUser() user: AuthUser) {
    return this.blocks.list(user);
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
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.blocks.block(user, body.userId);
  }

  @ApiOperation({
    summary: '차단 해제',
    description: '친구 관계는 되살리지 않음. 404 BLOCK_NOT_FOUND',
  })
  @Delete(':userId')
  @HttpCode(204)
  async unblock(
    @ZodParam('userId', z.uuid()) userId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.blocks.unblock(user, userId);
  }
}
