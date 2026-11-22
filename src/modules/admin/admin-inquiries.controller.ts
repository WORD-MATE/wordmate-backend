import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodBody, ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import {
  AdminInquiryPage,
  AdminInquiryQuery,
  AnswerInquiry,
} from '../support/inquiries.schemas.js';
import { InquiriesService } from '../support/inquiries.service.js';

@ApiTags('admin')
@Auth('ADMIN')
@Controller('admin/inquiries')
export class AdminInquiriesController {
  constructor(private readonly inquiries: InquiriesService) {}

  @ApiOperation({
    summary: '1:1 문의 목록',
    description: '최신순. 상세는 GET /inquiries/{inquiryId}를 관리자로 조회',
  })
  @Get()
  @ZodResponse(AdminInquiryPage)
  list(@ZodQuery(AdminInquiryQuery) query: z.infer<typeof AdminInquiryQuery>) {
    return this.inquiries.adminList(query);
  }

  @ApiOperation({
    summary: '문의 답변',
    description:
      '상태를 ANSWERED로 바꿈. 다시 호출하면 답변을 고침. 처음 답할 때만 작성자에게 INQUIRY_ANSWERED 알림. 400 INVALID_REQUEST / 404 INQUIRY_NOT_FOUND',
  })
  @Post(':inquiryId/answer')
  @HttpCode(204)
  async answer(
    @ZodParam('inquiryId', z.uuid()) inquiryId: string,
    @ZodBody(AnswerInquiry) body: z.infer<typeof AnswerInquiry>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.inquiries.answer(request.user as AuthUser, inquiryId, body, request);
  }
}
