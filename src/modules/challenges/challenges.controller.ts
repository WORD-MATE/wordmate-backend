import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Idempotent } from '../../common/idempotency/idempotent.decorator.js';
import { ZodBody, ZodParam, ZodResponse } from '../../common/zod/decorators.js';
import {
  ChallengeAttempt,
  ChallengeResult,
  ChallengeToday,
  CompleteChallenge,
} from './challenges.schemas.js';
import { ChallengesService } from './challenges.service.js';

@ApiTags('challenges')
@Auth('STUDENT')
@Controller('challenges/today')
export class ChallengesController {
  constructor(private readonly challenges: ChallengesService) {}

  @ApiOperation({
    summary: '오늘의 챌린지',
    description:
      '하루(KST) 한 번, 모두 같은 문제·같은 순서. 기본 단어팩에서 한→영 4지선다 10문항, 문항당 10초. 문제가 없으면 이때 만든다',
  })
  @Get()
  @ZodResponse(ChallengeToday)
  today(@CurrentUser() user: AuthUser) {
    return this.challenges.today(user);
  }

  @ApiOperation({
    summary: '챌린지 시작',
    description:
      '정답은 내려주지 않는다. 시작 시각부터 서버가 시간을 잰다. 이미 끝냈으면 409 CHALLENGE_ALREADY_DONE, 시작만 했으면 409 CHALLENGE_IN_PROGRESS(detail.attemptId로 이어서 끝내기)',
  })
  @Post('attempt')
  @ZodResponse(ChallengeAttempt, { status: 201 })
  start(@CurrentUser() user: AuthUser) {
    return this.challenges.start(user);
  }

  @ApiOperation({
    summary: '챌린지 끝내기',
    description:
      'Idempotency-Key 필수. 시작 시각부터 모든 문항을 제한 시간까지 쓴 시간(+ 여유)이 지나 끝내면 모두 미응답. 문항별 제한 시간을 넘긴 답도 미응답. XP는 정답 1개당 3 (하루 500 상한 포함). 404 CHALLENGE_ATTEMPT_NOT_FOUND, 409 CHALLENGE_ALREADY_DONE',
  })
  @Post('attempt/:attemptId/complete')
  @Idempotent({ required: true })
  @HttpCode(200)
  @ZodResponse(ChallengeResult)
  complete(
    @ZodParam('attemptId', z.uuid()) attemptId: string,
    @ZodBody(CompleteChallenge) body: z.infer<typeof CompleteChallenge>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.challenges.complete(user, attemptId, body);
  }
}
