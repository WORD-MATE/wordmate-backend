import { Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { Idempotent } from '../../common/idempotency/idempotent.decorator.js';
import { ZodBody, ZodParam, ZodResponse } from '../../common/zod/decorators.js';
import { DAILY_REVIEW_LIMIT, MIN_COUNTED_ELAPSED_MS } from './grading.js';
import {
  AnswerResult,
  CompleteResult,
  CompleteStudy,
  CurrentStudy,
  ReviewSummary,
  StartStudy,
  StudySession,
  SubmitAnswer,
} from './study.schemas.js';
import { StudyAnswersService } from './study-answers.service.js';
import { StudyCompleteService } from './study-complete.service.js';
import { SESSION_TTL_DAYS, StudySessionsService } from './study-sessions.service.js';

const SessionIdParam = () => ZodParam('sessionId', z.uuid());

@ApiTags('study')
@Controller('study/sessions')
export class StudyController {
  constructor(
    private readonly sessions: StudySessionsService,
    private readonly answers: StudyAnswersService,
    private readonly completion: StudyCompleteService,
  ) {}

  @ApiOperation({
    summary: '학습 시작',
    description:
      '서버가 문항·보기를 만들어 고정 저장. 4지선다 보기 = 정답 + 그 단어팩의 다른 단어 3개 (보이는 글자가 겹치는 단어는 뺌). TYPING은 정답을 내려주지 않음. 같은 팩(팩이 없으면 같은 소스)에 이어할 학습이 있으면 409 STUDY_SESSION_EXISTS (detail.sessionId), force=true면 그 학습을 버리고 새로 시작. 소스: PACK(packId), FAVORITE·WRONG_NOTE(wordIds로 일부만), RECORD_WRONG(recordId, 그 기록에서 틀린 단어), REVIEW(오늘 복습할 단어 최대 30개)',
  })
  @Post()
  @ZodResponse(StudySession, { status: 201 })
  start(@ZodBody(StartStudy) body: z.infer<typeof StartStudy>, @CurrentUser() user: AuthUser) {
    return this.sessions.start(user, body);
  }

  @ApiOperation({
    summary: '이어할 학습',
    description: `가장 최근에 진행한 학습 하나, 없으면 null. 마지막으로 진행한 지 ${SESSION_TTL_DAYS}일이 지나면 만료`,
  })
  @Get('current')
  @ZodResponse(CurrentStudy)
  current(@CurrentUser() user: AuthUser) {
    return this.sessions.current(user);
  }

  @ApiOperation({
    summary: '학습 조회 (이어하기 복원)',
    description: '문항·보기 순서는 만들 때 그대로. answers를 보고 다음 문항부터 이어감',
  })
  @Get(':sessionId')
  @ZodResponse(StudySession)
  get(@SessionIdParam() sessionId: string, @CurrentUser() user: AuthUser) {
    return this.sessions.get(user, sessionId);
  }

  @ApiOperation({
    summary: '답안 제출·채점',
    description: `문항마다 저장. 실패하면 같은 Idempotency-Key로 다시 보냄. CHOICE는 choiceIndex, TYPING은 typedAnswer(공백·대소문자 무시, EN_TO_KO는 띄어쓰기 무시하고 뜻 중 하나와 일치), FLASHCARD는 known. elapsedMs가 ${MIN_COUNTED_ELAPSED_MS}ms 미만이면 counted=false. 틀리면 오답노트에 추가. CHOICE·TYPING은 다시 제출하면 409, FLASHCARD는 덮어씀`,
  })
  @Post(':sessionId/answers')
  @HttpCode(200)
  // 오프라인 동안 쌓인 답안을 한꺼번에 다시 보내거나 플래시카드를 빠르게 넘겨도 막히지 않게 기본(분당 120)보다 넉넉히
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Idempotent()
  @ZodResponse(AnswerResult)
  submit(
    @SessionIdParam() sessionId: string,
    @ZodBody(SubmitAnswer) body: z.infer<typeof SubmitAnswer>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.answers.submit(user, sessionId, body);
  }

  @ApiOperation({
    summary: '학습 종료',
    description:
      '결과·기록·XP·스트릭. 같은 Idempotency-Key로 다시 보내면 같은 결과, 이미 끝난 학습은 409 STUDY_SESSION_CLOSED. XP: 정답당 4지선다 +1, 직접 입력 +2, 오답노트 복습 +1(너무 빠른 답 제외), 팩 전체를 4지선다·직접 입력으로 끝까지 풀면 완주 +10(같은 팩 하루 1회), 하루 최대 500. 스트릭은 답을 1개 이상 낸 학습을 끝내면 인정',
  })
  @Post(':sessionId/complete')
  @HttpCode(200)
  @Idempotent()
  @ZodResponse(CompleteResult)
  complete(
    @SessionIdParam() sessionId: string,
    @ZodBody(CompleteStudy) body: z.infer<typeof CompleteStudy>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.completion.complete(user, sessionId, body);
  }

  @ApiOperation({
    summary: '학습 버리기',
    description: '기록을 남기지 않음. 끝난 학습은 409 STUDY_SESSION_CLOSED',
  })
  @Delete(':sessionId')
  @HttpCode(204)
  async remove(@SessionIdParam() sessionId: string, @CurrentUser() user: AuthUser): Promise<void> {
    await this.sessions.remove(user, sessionId);
  }
}

@ApiTags('study')
@Controller('study')
export class StudyReviewController {
  constructor(private readonly sessions: StudySessionsService) {}

  @ApiOperation({
    summary: '오늘의 복습',
    description: `간격 반복(1·3·7·14·30일). 처음 답한 다음 날부터 복습할 단어가 되고, 복습에서 맞힐 때마다 다음 간격으로, 틀리면 다음 날부터 다시. 하루 최대 ${DAILY_REVIEW_LIMIT}개. 복습 시작: POST /study/sessions (source=REVIEW)`,
  })
  @Get('review')
  @ZodResponse(ReviewSummary)
  review(@CurrentUser() user: AuthUser) {
    return this.sessions.reviewSummary(user);
  }
}
