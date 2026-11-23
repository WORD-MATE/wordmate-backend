import { Controller, Delete, Get, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodBody, ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import {
  CreateForbiddenWord,
  ForbiddenWordCreated,
  ForbiddenWordPage,
  ForbiddenWordQuery,
  UpdateForbiddenWord,
} from './admin-forbidden-words.schemas.js';
import { AdminForbiddenWordsService } from './admin-forbidden-words.service.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;
const WordIdParam = () => ZodParam('wordId', z.uuid());

@ApiTags('admin')
@Auth('ADMIN')
@Controller('admin/forbidden-words')
export class AdminForbiddenWordsController {
  constructor(private readonly words: AdminForbiddenWordsService) {}

  @ApiOperation({ summary: '금칙어·허용 단어 목록', description: '최근 등록순' })
  @Get()
  @ZodResponse(ForbiddenWordPage)
  list(@ZodQuery(ForbiddenWordQuery) query: z.infer<typeof ForbiddenWordQuery>) {
    return this.words.list(query);
  }

  @ApiOperation({
    summary: '금칙어·허용 단어 등록',
    description:
      '앞뒤 공백 제거. 모든 서버에 바로 반영. 409 ADMIN_FORBIDDEN_WORD_DUPLICATE(같은 종류에 같은 단어)',
  })
  @Post()
  @ZodResponse(ForbiddenWordCreated, { status: 201 })
  create(
    @ZodBody(CreateForbiddenWord) body: z.infer<typeof CreateForbiddenWord>,
    @Req() request: FastifyRequest,
  ) {
    return this.words.create(currentUser(request), body, request);
  }

  @ApiOperation({
    summary: '금칙어 수정',
    description: '404 ADMIN_FORBIDDEN_WORD_NOT_FOUND, 409 ADMIN_FORBIDDEN_WORD_DUPLICATE',
  })
  @Patch(':wordId')
  @HttpCode(204)
  async update(
    @WordIdParam() wordId: string,
    @ZodBody(UpdateForbiddenWord) body: z.infer<typeof UpdateForbiddenWord>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.words.update(currentUser(request), wordId, body.word, request);
  }

  @ApiOperation({ summary: '금칙어 삭제', description: '404 ADMIN_FORBIDDEN_WORD_NOT_FOUND' })
  @Delete(':wordId')
  @HttpCode(204)
  async remove(@WordIdParam() wordId: string, @Req() request: FastifyRequest): Promise<void> {
    await this.words.remove(currentUser(request), wordId, request);
  }
}
