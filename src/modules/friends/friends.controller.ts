import { Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ZodBody, ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import {
  FriendList,
  FriendRequestCreated,
  FriendRequestList,
  FriendRequestQuery,
  SendFriendRequest,
} from './friends.schemas.js';
import { FRIEND_LIMIT, FriendsService } from './friends.service.js';

@ApiTags('friends')
@Auth('STUDENT')
@Controller('friends')
export class FriendsController {
  constructor(private readonly friends: FriendsService) {}

  @ApiOperation({ summary: '친구 목록', description: `페이지네이션 없음 (최대 ${FRIEND_LIMIT}명)` })
  @Get()
  @ZodResponse(FriendList)
  list(@CurrentUser() user: AuthUser) {
    return this.friends.list(user);
  }

  @ApiOperation({ summary: '받은·보낸 친구 요청' })
  @Get('requests')
  @ZodResponse(FriendRequestList)
  requests(
    @ZodQuery(FriendRequestQuery) query: z.infer<typeof FriendRequestQuery>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.friends.requests(user, query);
  }

  @ApiOperation({
    summary: '친구 요청',
    description:
      '상대가 이미 나에게 요청했으면 바로 친구(requestId null). 400 FRIEND_SELF, 403 FRIEND_NOT_ALLOWED(교사 등), 404 USER_NOT_FOUND, 409 FRIEND_ALREADY / FRIEND_REQUEST_DUPLICATE / FRIEND_LIMIT_EXCEEDED',
  })
  @Post('requests')
  @ZodResponse(FriendRequestCreated, { status: 201 })
  send(
    @ZodBody(SendFriendRequest) body: z.infer<typeof SendFriendRequest>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.friends.request(user, body.userId);
  }

  @ApiOperation({
    summary: '친구 요청 수락',
    description:
      '받은 요청만(403). 404 FRIEND_REQUEST_NOT_FOUND / USER_NOT_FOUND(보낸 사람이 정지·탈퇴·휴면이면 요청을 지움), 409 FRIEND_LIMIT_EXCEEDED(양쪽 확인)',
  })
  @Post('requests/:requestId/accept')
  @HttpCode(204)
  async accept(
    @ZodParam('requestId', z.uuid()) requestId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.friends.accept(user, requestId);
  }

  @ApiOperation({
    summary: '친구 요청 거절·취소',
    description: '받은 요청은 거절, 보낸 요청은 취소',
  })
  @Delete('requests/:requestId')
  @HttpCode(204)
  async removeRequest(
    @ZodParam('requestId', z.uuid()) requestId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.friends.removeRequest(user, requestId);
  }

  @ApiOperation({ summary: '친구 삭제', description: '양쪽에서 함께 지움. 404 FRIEND_NOT_FOUND' })
  @Delete(':userId')
  @HttpCode(204)
  async remove(
    @ZodParam('userId', z.uuid()) userId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.friends.remove(user, userId);
  }
}
