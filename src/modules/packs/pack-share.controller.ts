import { Controller, Delete, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodParam, ZodResponse } from '../../common/zod/decorators.js';
import { PREVIEW_WORD_LIMIT, PackShareService } from './pack-share.service.js';
import { PackSummary, SharedPackPreview, ShareInfo } from './packs.schemas.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;
const PackIdParam = () => ZodParam('packId', z.uuid());
const ShareCodeParam = () => ZodParam('shareCode', z.string().regex(/^[A-Za-z0-9]{12}$/));

@ApiTags('packs')
@Controller('packs')
export class PackShareController {
  constructor(private readonly shares: PackShareService) {}

  @ApiOperation({
    summary: '공유 링크 만들기',
    description:
      '이미 공유 중이면 같은 코드를 돌려줌. 이 시점에 이름·설명·모든 단어를 금칙어로 다시 검사 (걸리면 detail.wordId). 내 단어팩만',
  })
  @Post(':packId/share')
  @HttpCode(200)
  @ZodResponse(ShareInfo)
  share(@PackIdParam() packId: string, @Req() request: FastifyRequest) {
    return this.shares.share(currentUser(request), packId);
  }

  @ApiOperation({
    summary: '공유 중지',
    description: '공유 중이 아니어도 204. 다시 공유하면 새 코드',
  })
  @Delete(':packId/share')
  @HttpCode(204)
  async unshare(@PackIdParam() packId: string, @Req() request: FastifyRequest): Promise<void> {
    await this.shares.unshare(currentUser(request), packId);
  }

  @ApiOperation({
    summary: '공유 단어팩 미리보기',
    description: `단어는 ${PREVIEW_WORD_LIMIT}개까지`,
  })
  @Get('shared/:shareCode')
  @ZodResponse(SharedPackPreview)
  preview(@ShareCodeParam() shareCode: string, @Req() request: FastifyRequest) {
    return this.shares.preview(currentUser(request), shareCode);
  }

  @ApiOperation({
    summary: '공유 단어팩 복사',
    description:
      '단어까지 복사한 독립된 내 단어팩을 만듦. 이름이 겹치면 " (2)"를 붙임. 복사본을 지웠다면 다시 복사 가능',
  })
  @Post('shared/:shareCode/copy')
  @ZodResponse(PackSummary, { status: 201 })
  copy(@ShareCodeParam() shareCode: string, @Req() request: FastifyRequest) {
    return this.shares.copy(currentUser(request), shareCode);
  }
}
