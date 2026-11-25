import { Controller, Delete, Get, HttpCode, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ZodBody, ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import {
  CreatePack,
  PackCategoryList,
  PackDetail,
  PackListQuery,
  PackPage,
  PackSummary,
  UpdatePack,
} from './packs.schemas.js';
import { PacksService } from './packs.service.js';

const PackIdParam = () => ZodParam('packId', z.uuid());

@ApiTags('packs')
@Controller('packs')
export class PacksController {
  constructor(private readonly packs: PacksService) {}

  @ApiOperation({ summary: '단어팩 분류 목록' })
  @Get('categories')
  @ZodResponse(PackCategoryList)
  categories() {
    return this.packs.categories();
  }

  @ApiOperation({
    summary: '단어팩 목록·검색',
    description:
      'type=DEFAULT는 기본 단어팩, MINE은 내 단어팩. 추천순은 기본 팩이면 관리자 지정 순서, 내 팩이면 최근 수정순',
  })
  @Get()
  @ZodResponse(PackPage)
  list(
    @ZodQuery(PackListQuery) query: z.infer<typeof PackListQuery>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.packs.list(user, query);
  }

  @ApiOperation({
    summary: '단어팩 만들기',
    description: '기본 단어팩(type=DEFAULT)은 관리자만. 분류(categoryId)는 기본 단어팩에만 적용',
  })
  @Post()
  @ZodResponse(PackSummary, { status: 201 })
  create(@ZodBody(CreatePack) body: z.infer<typeof CreatePack>, @CurrentUser() user: AuthUser) {
    return this.packs.create(user, body);
  }

  @ApiOperation({ summary: '단어팩 상세' })
  @Get(':packId')
  @ZodResponse(PackDetail)
  detail(@PackIdParam() packId: string, @CurrentUser() user: AuthUser) {
    return this.packs.detail(user, packId);
  }

  @ApiOperation({ summary: '단어팩 수정' })
  @Patch(':packId')
  @ZodResponse(PackSummary)
  update(
    @PackIdParam() packId: string,
    @ZodBody(UpdatePack) body: z.infer<typeof UpdatePack>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.packs.update(user, packId, body);
  }

  @ApiOperation({ summary: '단어팩 삭제', description: '복구 불가. 공유 링크도 무효가 됨' })
  @Delete(':packId')
  @HttpCode(204)
  async remove(@PackIdParam() packId: string, @CurrentUser() user: AuthUser): Promise<void> {
    await this.packs.remove(user, packId);
  }
}
