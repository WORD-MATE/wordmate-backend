import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import {
  CalendarQuery,
  CalendarStats,
  RecordDetail,
  RecordListQuery,
  RecordPage,
  StreakStats,
  SummaryQuery,
  SummaryStats,
} from './records.schemas.js';
import { RecordsService } from './records.service.js';

@ApiTags('records')
@Controller('records')
export class RecordsController {
  constructor(private readonly records: RecordsService) {}

  @ApiOperation({ summary: '학습 기록 목록', description: '최신순. date로 그날(KST) 기록만' })
  @Get()
  @ZodResponse(RecordPage)
  list(
    @ZodQuery(RecordListQuery) query: z.infer<typeof RecordListQuery>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.records.list(user, query);
  }

  @ApiOperation({
    summary: '학습 기록 상세',
    description:
      '학습 결과 화면과 같은 응답. 틀린 단어만 다시 풀기: POST /study/sessions (source=RECORD_WRONG, recordId)',
  })
  @Get(':recordId')
  @ZodResponse(RecordDetail)
  detail(@ZodParam('recordId', z.uuid()) recordId: string, @CurrentUser() user: AuthUser) {
    return this.records.detail(user, recordId);
  }
}

@ApiTags('stats')
@Controller('stats')
export class StatsController {
  constructor(private readonly records: RecordsService) {}

  @ApiOperation({
    summary: '연속 학습일',
    description: '하루(KST)에 답을 1개 이상 낸 학습을 끝내면 인정. 오늘·어제 학습하지 않았으면 0',
  })
  @Get('streak')
  @ZodResponse(StreakStats)
  streak(@CurrentUser() user: AuthUser) {
    return this.records.streak(user);
  }

  @ApiOperation({
    summary: '월별 학습 달력',
    description: '학습한 날만. 날짜를 누르면 GET /records?date=. 미래의 달은 400',
  })
  @Get('calendar')
  @ZodResponse(CalendarStats)
  calendar(
    @ZodQuery(CalendarQuery) query: z.infer<typeof CalendarQuery>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.records.calendar(user, query.month);
  }

  @ApiOperation({
    summary: '학습량·정답률 통계',
    description: 'TODAY는 오늘, WEEK는 이번 주(월요일부터), MONTH는 이번 달 1일부터 오늘까지 (KST)',
  })
  @Get('summary')
  @ZodResponse(SummaryStats)
  summary(
    @ZodQuery(SummaryQuery) query: z.infer<typeof SummaryQuery>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.records.summary(user, query.period);
  }
}
