import { Controller, Delete, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodBody, ZodParam, ZodResponse } from '../../common/zod/decorators.js';
import { CreateFaq, FaqCreated, UpdateFaq } from '../support/faqs.schemas.js';
import { FaqsService } from '../support/faqs.service.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;
const FaqIdParam = () => ZodParam('faqId', z.uuid());

@ApiTags('admin')
@Auth('ADMIN')
@Controller('admin/faqs')
export class AdminFaqsController {
  constructor(private readonly faqs: FaqsService) {}

  @ApiOperation({ summary: 'FAQ 등록', description: '순서를 비우면 그 분류의 맨 뒤' })
  @Post()
  @ZodResponse(FaqCreated, { status: 201 })
  create(@ZodBody(CreateFaq) body: z.infer<typeof CreateFaq>, @Req() request: FastifyRequest) {
    return this.faqs.create(currentUser(request), body, request);
  }

  @ApiOperation({ summary: 'FAQ 수정', description: '보낸 항목만 바꿈. 404 FAQ_NOT_FOUND' })
  @Patch(':faqId')
  @HttpCode(204)
  async update(
    @FaqIdParam() faqId: string,
    @ZodBody(UpdateFaq) body: z.infer<typeof UpdateFaq>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.faqs.update(currentUser(request), faqId, body, request);
  }

  @ApiOperation({ summary: 'FAQ 삭제', description: '404 FAQ_NOT_FOUND' })
  @Delete(':faqId')
  @HttpCode(204)
  async remove(@FaqIdParam() faqId: string, @Req() request: FastifyRequest): Promise<void> {
    await this.faqs.remove(currentUser(request), faqId, request);
  }
}
