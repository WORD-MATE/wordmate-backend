import { Controller, Delete, Get, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodBody, ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import {
  AdminNoticePage,
  AdminNoticeQuery,
  CreateNotice,
  NoticeCreated,
  UpdateNotice,
} from '../support/notices.schemas.js';
import { NoticesService } from '../support/notices.service.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;
const NoticeIdParam = () => ZodParam('noticeId', z.uuid());

@ApiTags('admin')
@Auth('ADMIN')
@Controller('admin/notices')
export class AdminNoticesController {
  constructor(private readonly notices: NoticesService) {}

  @ApiOperation({ summary: '공지 목록 (초안 포함)', description: '지운 공지 제외, 최신순' })
  @Get()
  @ZodResponse(AdminNoticePage)
  list(@ZodQuery(AdminNoticeQuery) query: z.infer<typeof AdminNoticeQuery>) {
    return this.notices.adminList(query);
  }

  @ApiOperation({
    summary: '공지 등록',
    description: 'sendPush면 공개 공지일 때 전체 사용자에게 NOTICE 알림(공지 알림을 끈 사람 제외)',
  })
  @Post()
  @ZodResponse(NoticeCreated, { status: 201 })
  create(
    @ZodBody(CreateNotice) body: z.infer<typeof CreateNotice>,
    @Req() request: FastifyRequest,
  ) {
    return this.notices.create(currentUser(request), body, request);
  }

  @ApiOperation({ summary: '공지 수정', description: '보낸 항목만 바꿈. 404 NOTICE_NOT_FOUND' })
  @Patch(':noticeId')
  @HttpCode(204)
  async update(
    @NoticeIdParam() noticeId: string,
    @ZodBody(UpdateNotice) body: z.infer<typeof UpdateNotice>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.notices.update(currentUser(request), noticeId, body, request);
  }

  @ApiOperation({ summary: '공지 삭제', description: '사용자에게는 404. 404 NOTICE_NOT_FOUND' })
  @Delete(':noticeId')
  @HttpCode(204)
  async remove(@NoticeIdParam() noticeId: string, @Req() request: FastifyRequest): Promise<void> {
    await this.notices.remove(currentUser(request), noticeId, request);
  }
}
