import { Controller, Delete, Get, HttpCode, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { CursorQuery } from '../../common/pagination.js';
import { ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import { WordFavoritesService } from './word-favorites.service.js';
import { WordSearchService } from './word-search.service.js';
import { WordSearchQuery, WordWithPackPage } from './words.schemas.js';

const WordIdParam = () => ZodParam('wordId', z.uuid());

@ApiTags('words')
@Controller('words')
export class WordLibraryController {
  constructor(
    private readonly search: WordSearchService,
    private readonly favorites: WordFavoritesService,
  ) {}

  @ApiOperation({
    summary: '단어 검색',
    description:
      '기본 단어팩 + 내 단어팩에서 영어나 뜻에 검색어가 들어 있는 단어. 대소문자 무시, 영어 알파벳순',
  })
  @Get('search')
  @ZodResponse(WordWithPackPage)
  searchWords(
    @ZodQuery(WordSearchQuery) query: z.infer<typeof WordSearchQuery>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.search.search(user, query);
  }

  @ApiOperation({
    summary: '즐겨찾기 단어 목록',
    description: '최근에 즐겨찾기한 순. 삭제됐거나 볼 수 없게 된 단어는 빠짐',
  })
  @Get('favorites')
  @ZodResponse(WordWithPackPage)
  listFavorites(
    @ZodQuery(CursorQuery) query: z.infer<typeof CursorQuery>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.favorites.list(user, query);
  }

  @ApiOperation({
    summary: '즐겨찾기 추가',
    description: '이미 즐겨찾기여도 204. 기본 단어팩이나 내 단어팩의 단어만',
  })
  @Put(':wordId/favorite')
  @HttpCode(204)
  async addFavorite(@WordIdParam() wordId: string, @CurrentUser() user: AuthUser): Promise<void> {
    await this.favorites.add(user, wordId);
  }

  @ApiOperation({ summary: '즐겨찾기 해제', description: '즐겨찾기가 아니어도 204' })
  @Delete(':wordId/favorite')
  @HttpCode(204)
  async removeFavorite(
    @WordIdParam() wordId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.favorites.remove(user, wordId);
  }
}
