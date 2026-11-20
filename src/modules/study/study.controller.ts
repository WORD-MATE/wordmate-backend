import { Controller, Delete, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodBody, ZodParam, ZodResponse } from '../../common/zod/decorators.js';
import { CurrentStudy, StartStudy, StudySession } from './study.schemas.js';
import { SESSION_TTL_DAYS, StudySessionsService } from './study-sessions.service.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;
const SessionIdParam = () => ZodParam('sessionId', z.uuid());

@ApiTags('study')
@Controller('study/sessions')
export class StudyController {
  constructor(private readonly sessions: StudySessionsService) {}

  @ApiOperation({
    summary: '학습 시작',
    description:
      '서버가 문항·보기를 만들어 고정 저장. 4지선다 보기 = 정답 + 그 단어팩의 다른 단어 3개 (보이는 글자가 겹치는 단어는 뺌). TYPING은 정답을 내려주지 않음. 같은 팩(팩이 없으면 같은 소스)에 이어할 학습이 있으면 409 STUDY_SESSION_EXISTS (detail.sessionId), force=true면 그 학습을 버리고 새로 시작. 지금은 PACK·FAVORITE만',
  })
  @Post()
  @ZodResponse(StudySession, { status: 201 })
  start(@ZodBody(StartStudy) body: z.infer<typeof StartStudy>, @Req() request: FastifyRequest) {
    return this.sessions.start(currentUser(request), body);
  }

  @ApiOperation({
    summary: '이어할 학습',
    description: `가장 최근에 진행한 학습 하나, 없으면 null. 마지막으로 진행한 지 ${SESSION_TTL_DAYS}일이 지나면 만료`,
  })
  @Get('current')
  @ZodResponse(CurrentStudy)
  current(@Req() request: FastifyRequest) {
    return this.sessions.current(currentUser(request));
  }

  @ApiOperation({
    summary: '학습 조회 (이어하기 복원)',
    description: '문항·보기 순서는 만들 때 그대로. answers를 보고 다음 문항부터 이어감',
  })
  @Get(':sessionId')
  @ZodResponse(StudySession)
  get(@SessionIdParam() sessionId: string, @Req() request: FastifyRequest) {
    return this.sessions.get(currentUser(request), sessionId);
  }

  @ApiOperation({
    summary: '학습 버리기',
    description: '기록을 남기지 않음. 끝난 학습은 409 STUDY_SESSION_CLOSED',
  })
  @Delete(':sessionId')
  @HttpCode(204)
  async remove(@SessionIdParam() sessionId: string, @Req() request: FastifyRequest): Promise<void> {
    await this.sessions.remove(currentUser(request), sessionId);
  }
}
