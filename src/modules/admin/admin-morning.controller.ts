import { Controller, Get, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ZodBody, ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import { parseMorningText } from '../morning/morning-parser.js';
import {
  AdminMorningCreated,
  AdminMorningDetail,
  AdminMorningPage,
  AdminMorningQuery,
  CreateAdminMorning,
  ParsedMorningResult,
  ParseMorningText,
  UpdateAdminMorning,
} from './admin-morning.schemas.js';
import { AdminMorningService } from './admin-morning.service.js';

const MorningIdParam = () => ZodParam('morningId', z.uuid());

@ApiTags('admin')
@Auth('ADMIN')
@Controller('admin/morning')
export class AdminMorningController {
  constructor(private readonly morning: AdminMorningService) {}

  @ApiOperation({ summary: '오늘의 문장 목록', description: '날짜 최신순' })
  @Get()
  @ZodResponse(AdminMorningPage)
  list(@ZodQuery(AdminMorningQuery) query: z.infer<typeof AdminMorningQuery>) {
    return this.morning.list(query);
  }

  @ApiOperation({
    summary: '게시물 본문 분석',
    description:
      '저장하지 않는 미리보기. 줄마다 "머리말: 내용", 칸은 " | ". 문장: / 뜻: / 어휘: 영어 | 뜻1, 뜻2 | 예문 / 퀴즈 빈칸: 질문 | 정답1, 정답2 | 해설 / 퀴즈 뜻·질문: 질문 | 보기1 / 보기2 | 정답 | 해설',
  })
  @Post('parse')
  @HttpCode(200)
  @ZodResponse(ParsedMorningResult)
  parse(@ZodBody(ParseMorningText) body: z.infer<typeof ParseMorningText>) {
    return parseMorningText(body.text);
  }

  @ApiOperation({
    summary: '오늘의 문장 상세',
    description: '404 MORNING_NOT_FOUND',
  })
  @Get(':morningId')
  @ZodResponse(AdminMorningDetail)
  detail(@MorningIdParam() morningId: string) {
    return this.morning.detail(morningId);
  }

  @ApiOperation({
    summary: '오늘의 문장 등록',
    description:
      '검수 대기(PENDING_REVIEW)로 등록. 어휘·퀴즈는 비어 있어도 되고 강조 위치를 비우면 문장에서 찾음. 409 MORNING_DATE_EXISTS(replace=false) / MORNING_ALREADY_PUBLISHED(게시된 날짜는 교체 불가)',
  })
  @Post()
  @ZodResponse(AdminMorningCreated, { status: 201 })
  create(
    @ZodBody(CreateAdminMorning) body: z.infer<typeof CreateAdminMorning>,
    @CurrentUser() user: AuthUser,
    @Req() request: FastifyRequest,
  ) {
    return this.morning.create(user, body, request);
  }

  @ApiOperation({
    summary: '오늘의 문장 수정',
    description:
      '보낸 항목만(어휘·퀴즈는 통째로). 예약·게시된 문장은 게시할 수 있는 상태를 유지해야 함(400). 게시된 문장의 날짜는 못 바꿈(409 MORNING_ALREADY_PUBLISHED). 이미 푼 기록은 그대로',
  })
  @Patch(':morningId')
  @HttpCode(204)
  async update(
    @MorningIdParam() morningId: string,
    @ZodBody(UpdateAdminMorning) body: z.infer<typeof UpdateAdminMorning>,
    @CurrentUser() user: AuthUser,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.morning.update(user, morningId, body, request);
  }

  @ApiOperation({
    summary: '게시 예약',
    description:
      '날짜가 되면 06:00에 게시(이미 지났으면 바로). 400 MORNING_INCOMPLETE(문장·뜻·어휘·퀴즈 누락) / MORNING_BLANK_NOT_IN_SENTENCE / MORNING_INVALID(강조 위치·보기), detail.issues에 전체 목록',
  })
  @Post(':morningId/publish')
  @HttpCode(204)
  async publish(
    @MorningIdParam() morningId: string,
    @CurrentUser() user: AuthUser,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.morning.publish(user, morningId, request);
  }

  @ApiOperation({
    summary: '게시 취소',
    description: '검수 대기로 돌림. 게시된 문장은 앱에서 사라짐',
  })
  @Post(':morningId/unpublish')
  @HttpCode(204)
  async unpublish(
    @MorningIdParam() morningId: string,
    @CurrentUser() user: AuthUser,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.morning.unpublish(user, morningId, request);
  }
}
