import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Idempotent } from '../../common/idempotency/idempotent.decorator.js';
import { CursorQuery } from '../../common/pagination.js';
import { ZodBody, ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import {
  CompleteMorningQuiz,
  MorningList,
  MorningQuizResult,
  MorningSentence,
  SaveMorningWords,
  SaveMorningWordsResult,
} from './morning.schemas.js';
import { MorningService } from './morning.service.js';
import { MORNING_XP } from './morning-rules.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;
const DateParam = () => ZodParam('date', z.iso.date());

@ApiTags('morning')
@Auth('USER')
@Controller('morning')
export class MorningController {
  constructor(private readonly morning: MorningService) {}

  @ApiOperation({
    summary: '오늘의 문장',
    description:
      '06:00 KST에 바뀜. 오늘 문장이 없으면 가장 최근 문장(isFallback). 404 MORNING_NOT_FOUND(게시된 문장이 없음)',
  })
  @Get('today')
  @ZodResponse(MorningSentence)
  today(@Req() request: FastifyRequest) {
    return this.morning.today(currentUser(request));
  }

  @ApiOperation({ summary: '지난 문장 목록', description: '게시된 문장만 최신순' })
  @Get()
  @ZodResponse(MorningList)
  list(@ZodQuery(CursorQuery) query: CursorQuery, @Req() request: FastifyRequest) {
    return this.morning.list(currentUser(request), query);
  }

  @ApiOperation({
    summary: '날짜별 문장',
    description: '404 MORNING_NOT_FOUND(게시 전·미래·없는 날짜)',
  })
  @Get(':date')
  @ZodResponse(MorningSentence)
  byDate(@DateParam() date: string, @Req() request: FastifyRequest) {
    return this.morning.byDate(currentUser(request), date);
  }

  @ApiOperation({
    summary: '문장 퀴즈 완료',
    description: `모든 문항에 한 번씩 답해야 함(400). 빈칸은 앞뒤 공백 제거·대소문자 무시. XP는 오늘 문장을 처음 끝냈을 때 하루 한 번 ${MORNING_XP}(정답 수와 무관), 지난 문장은 기록만. 404 MORNING_NOT_FOUND`,
  })
  @Auth('STUDENT')
  @Post(':date/quiz/complete')
  @HttpCode(200)
  @Idempotent()
  @ZodResponse(MorningQuizResult)
  complete(
    @DateParam() date: string,
    @ZodBody(CompleteMorningQuiz) body: CompleteMorningQuiz,
    @Req() request: FastifyRequest,
  ) {
    return this.morning.complete(currentUser(request), date, body);
  }

  @ApiOperation({
    summary: '핵심 어휘를 내 단어팩에 저장',
    description:
      'packId와 newPackName 중 하나만(400). 이미 있는 단어는 건너뜀. 404 MORNING_NOT_FOUND / PACK_NOT_FOUND, 409 PACK_WORD_LIMIT_EXCEEDED(하나도 넣지 않음)',
  })
  @Auth('STUDENT')
  @Post(':date/save-words')
  @HttpCode(200)
  @ZodResponse(SaveMorningWordsResult)
  saveWords(
    @DateParam() date: string,
    @ZodBody(SaveMorningWords) body: SaveMorningWords,
    @Req() request: FastifyRequest,
  ) {
    return this.morning.saveWords(currentUser(request), date, body);
  }
}
