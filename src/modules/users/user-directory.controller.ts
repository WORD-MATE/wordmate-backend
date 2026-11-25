import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import { UserProfile, UserSearchPage, UserSearchQuery } from './user-directory.schemas.js';
import { UserDirectoryService } from './user-directory.service.js';

// /users/me 등 고정 경로는 Fastify가 파라미터 경로보다 먼저 고른다
@ApiTags('users')
@Auth('USER')
@Controller('users')
export class UserDirectoryController {
  constructor(private readonly directory: UserDirectoryService) {}

  @ApiOperation({
    summary: '사용자 검색',
    description:
      '친구 추가용. 이름(포함) 또는 학번(앞부분)으로 찾고 이름순. 교사·나·나를 차단한 사용자·정지·휴면·탈퇴 계정은 빠짐(내가 차단한 사용자는 나옴). 응답에 학번 없음, 랭킹 비공개면 tier null',
  })
  @Auth('STUDENT')
  @Get('search')
  @ZodResponse(UserSearchPage)
  search(
    @ZodQuery(UserSearchQuery) query: z.infer<typeof UserSearchQuery>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.directory.search(user, query);
  }

  @ApiOperation({
    summary: '사용자 프로필',
    description:
      '랭킹 비공개·정지·휴면이면 level·tier null(내 프로필은 보임). 탈퇴한 사용자는 이름 "탈퇴한 사용자"이고 나머지 null. 404 USER_NOT_FOUND(없거나 나를 차단함)',
  })
  @Get(':userId')
  @ZodResponse(UserProfile)
  profile(@ZodParam('userId', z.uuid()) userId: string, @CurrentUser() user: AuthUser) {
    return this.directory.profile(user, userId);
  }
}
