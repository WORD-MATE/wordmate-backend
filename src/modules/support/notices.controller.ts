import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { CursorQuery } from '../../common/pagination.js';
import { ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import { NoticeDetail, NoticeList } from './notices.schemas.js';
import { NoticesService } from './notices.service.js';

@ApiTags('support')
@Auth('USER')
@Controller('notices')
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  @ApiOperation({
    summary: '공지 목록',
    description: '고정 공지 먼저, 그다음 최신순. 읽음 여부 포함',
  })
  @Get()
  @ZodResponse(NoticeList)
  list(@ZodQuery(CursorQuery) query: z.infer<typeof CursorQuery>, @CurrentUser() user: AuthUser) {
    return this.notices.list(user, query);
  }

  @ApiOperation({
    summary: '공지 상세',
    description: '열면 읽음 처리. 삭제·비공개 공지는 404 NOTICE_NOT_FOUND',
  })
  @Get(':noticeId')
  @ZodResponse(NoticeDetail)
  detail(@ZodParam('noticeId', z.uuid()) noticeId: string, @CurrentUser() user: AuthUser) {
    return this.notices.detail(user, noticeId);
  }
}
