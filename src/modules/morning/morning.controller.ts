import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
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
  today(@CurrentUser() user: AuthUser) {
    return this.morning.today(user);
  }

  @ApiOperation({ summary: '지난 문장 목록', description: '게시된 문장만 최신순' })
  @Get()
  @ZodResponse(MorningList)
  list(@ZodQuery(CursorQuery) query: z.infer<typeof CursorQuery>, @CurrentUser() user: AuthUser) {
    return this.morning.list(user, query);
  }

  @ApiOperation({
    summary: '날짜별 문장',
    description: '404 MORNING_NOT_FOUND(게시 전·미래·없는 날짜)',
  })
  @Get(':date')
  @ZodResponse(MorningSentence)
  byDate(@DateParam() date: string, @CurrentUser() user: AuthUser) {
    return this.morning.byDate(user, date);
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
    @ZodBody(CompleteMorningQuiz) body: z.infer<typeof CompleteMorningQuiz>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.morning.complete(user, date, body);
  }

  @ApiOperation({
    summary: '핵심 어휘를 내 단어팩에 저장',
    description:
      'packId(내 단어팩)와 newPackName 중 하나만(400). 이미 있는 단어는 건너뜀. 404 MORNING_NOT_FOUND / PACK_NOT_FOUND(기본·남의 단어팩 포함), 409 PACK_WORD_LIMIT_EXCEEDED(하나도 넣지 않음) / PACK_LIMIT_EXCEEDED·PACK_NAME_DUPLICATE(새 팩)',
  })
  @Auth('STUDENT')
  @Post(':date/save-words')
  @HttpCode(200)
  @Idempotent()
  @ZodResponse(SaveMorningWordsResult)
  saveWords(
    @DateParam() date: string,
    @ZodBody(SaveMorningWords) body: z.infer<typeof SaveMorningWords>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.morning.saveWords(user, date, body);
  }
}
