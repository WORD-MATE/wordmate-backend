import { Controller, Get, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { SkipTermsCheck } from '../../common/auth/onboarding.decorator.js';
import { CursorQuery } from '../../common/pagination.js';
import { ZodBody, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import { XpHistoryPage } from '../xp/xp.schemas.js';
import { XpHistoryService } from '../xp/xp-history.service.js';
import { AgreementService } from './agreement.service.js';
import { avatarList } from './avatars.js';
import { Me } from './me.schema.js';
import { NextStepService } from './next-step.service.js';
import {
  AgreementStatus,
  AvatarList,
  NextStepResponse,
  PrivacySettings,
  SubmitAgreements,
  UpdatePrivacy,
  UpdateProfile,
} from './users.schemas.js';
import { UsersService } from './users.service.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;

@ApiTags('users')
@Auth('USER')
@Controller('users/me')
export class UsersController {
  constructor(
    private readonly agreements: AgreementService,
    private readonly nextStep: NextStepService,
    private readonly users: UsersService,
    private readonly xpHistoryService: XpHistoryService,
  ) {}

  @ApiOperation({ summary: '내 정보', description: '약관 동의 전에도 호출할 수 있음' })
  @SkipTermsCheck()
  @Get()
  @ZodResponse(Me)
  me(@Req() request: FastifyRequest) {
    return this.users.me(currentUser(request).userId);
  }

  @ApiOperation({ summary: '약관 동의 현황', description: '약관 동의 전에도 호출할 수 있음' })
  @SkipTermsCheck()
  @Get('agreements')
  @ZodResponse(AgreementStatus)
  agreementStatus(@Req() request: FastifyRequest) {
    return this.agreements.status(currentUser(request).userId);
  }

  @ApiOperation({
    summary: '약관 동의 제출',
    description: '동의 이력을 저장하고 다음 단계를 돌려줌',
  })
  @SkipTermsCheck()
  @Post('agreements')
  @HttpCode(200)
  @ZodResponse(NextStepResponse)
  async submitAgreements(
    @ZodBody(SubmitAgreements) body: z.infer<typeof SubmitAgreements>,
    @Req() request: FastifyRequest,
  ) {
    const user = currentUser(request);
    await this.agreements.submit(user.userId, body.items);
    return { nextStep: await this.nextStep.resolve(user) };
  }

  @ApiOperation({
    summary: '프로필 수정',
    description:
      '아바타와 대표 배지. 생략한 항목은 그대로, null이면 해제(아바타는 default). 이름·학번·학년·반은 DataGSM 값이라 바꿀 수 없음. 교사는 배지가 없어 대표 배지를 지정할 수 없음. 400 USER_AVATAR_NOT_FOUND / USER_BADGE_NOT_OWNED',
  })
  @Patch('profile')
  @ZodResponse(Me)
  updateProfile(
    @ZodBody(UpdateProfile) body: z.infer<typeof UpdateProfile>,
    @Req() request: FastifyRequest,
  ) {
    return this.users.updateProfile(currentUser(request).userId, body);
  }

  @ApiOperation({
    summary: '랭킹 공개 설정',
    description:
      '랭킹 첫 진입 안내와 설정 화면이 같이 씀(호출하면 rankingOnboarded=true). 비공개면 랭킹 목록에서 빠지지만 점수는 쌓이고 내 순위는 볼 수 있음',
  })
  @Auth('STUDENT')
  @Patch('privacy')
  @ZodResponse(PrivacySettings)
  updatePrivacy(
    @ZodBody(UpdatePrivacy) body: z.infer<typeof UpdatePrivacy>,
    @Req() request: FastifyRequest,
  ) {
    return this.users.updatePrivacy(currentUser(request).userId, body.rankingPublic);
  }

  @ApiOperation({
    summary: 'XP 적립 내역',
    description: '최신순. 하루 상한 등으로 덜 받았거나 못 받은 지급은 blockedReason으로 알려줌',
  })
  @Auth('STUDENT')
  @Get('xp-history')
  @ZodResponse(XpHistoryPage)
  xpHistory(
    @ZodQuery(CursorQuery) query: z.infer<typeof CursorQuery>,
    @Req() request: FastifyRequest,
  ) {
    return this.xpHistoryService.list(currentUser(request).userId, query);
  }
}

@ApiTags('users')
@Auth('USER')
@Controller('users')
export class AvatarsController {
  @ApiOperation({
    summary: '기본 아바타 목록',
    description: '정적 데이터라 앱에서 캐시해도 됨. imageUrl은 앱이 이미지 주소로 바꾸는 키',
  })
  @Get('avatars')
  @ZodResponse(AvatarList)
  list() {
    return avatarList();
  }
}
