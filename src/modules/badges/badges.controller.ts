import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import { BadgeList, BadgeQuery } from './badges.schemas.js';
import { BadgesService } from './badges.service.js';

@ApiTags('badges')
@Auth('USER')
@Controller('badges')
export class BadgesController {
  constructor(private readonly badges: BadgesService) {}

  @ApiOperation({
    summary: '배지 목록',
    description:
      '내 배지는 전체와 획득 여부, 다른 사람은 획득한 것만. 랭킹 비공개 사용자는 빈 배열. 404 USER_NOT_FOUND(없거나 탈퇴)',
  })
  @Get()
  @ZodResponse(BadgeList)
  list(@ZodQuery(BadgeQuery) query: z.infer<typeof BadgeQuery>, @CurrentUser() user: AuthUser) {
    return this.badges.list(user, query.userId);
  }
}
