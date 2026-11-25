import { Controller, Delete, Get, HttpCode, Patch, Post, Req } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { CommonErrors } from '../../common/errors/app-exception.js';
import { Idempotent } from '../../common/idempotency/idempotent.decorator.js';
import { ZodBody, ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import { WORD_FILE_MAX_ROWS, WordFileErrors } from './import/word-file.js';
import {
  AddWords,
  AddWordsResult,
  MAX_WORDS_PER_PACK,
  ParseResult,
  ParseWords,
  UpdateWord,
  WordItem,
  WordListQuery,
  WordPage,
} from './words.schemas.js';
import { WordsService } from './words.service.js';

const PackIdParam = () => ZodParam('packId', z.uuid());
const WordIdParam = () => ZodParam('wordId', z.uuid());

async function readUploadedFile(request: FastifyRequest): Promise<Buffer> {
  const missing = () =>
    CommonErrors.invalidRequest(
      { field: 'file' },
      'multipart/form-data의 file 필드로 파일을 보내 주세요.',
    );
  if (!request.isMultipart()) throw missing();
  const part = await request.file();
  if (part?.fieldname !== 'file') throw missing();
  try {
    return await part.toBuffer();
  } catch (error) {
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE')
      throw WordFileErrors.tooLarge();
    throw error;
  }
}

@ApiTags('words')
@Controller('packs/:packId/words')
export class WordsController {
  constructor(private readonly words: WordsService) {}

  @ApiOperation({ summary: '단어 목록', description: '추가한 순서대로' })
  @Get()
  @ZodResponse(WordPage)
  list(
    @PackIdParam() packId: string,
    @ZodQuery(WordListQuery) query: z.infer<typeof WordListQuery>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.words.list(user, packId, query);
  }

  @ApiOperation({
    summary: '단어 추가 (여러 개)',
    description: `같은 단어 판정은 대소문자·연속 공백 무시. 요청 안에서 겹치면 처음 것만 저장. 팩당 ${MAX_WORDS_PER_PACK}개를 넘는 단어는 에러 없이 excluded로 알려줌. 공유 중인 팩이면 단어도 금칙어 검사`,
  })
  @Post()
  @Idempotent()
  @ZodResponse(AddWordsResult, { status: 201 })
  add(
    @PackIdParam() packId: string,
    @ZodBody(AddWords) body: z.infer<typeof AddWords>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.words.add(user, packId, body);
  }

  @ApiOperation({
    summary: '구분자 텍스트 분석 (저장 안 함)',
    description: `한 줄에 단어 하나. 처음 나오는 / , 탭 앞이 영어, 뒤가 뜻(쉼표로 여러 개). 빈 줄은 건너뜀. ${MAX_WORDS_PER_PACK}줄까지`,
  })
  @Post('parse')
  @HttpCode(200)
  @ZodResponse(ParseResult)
  parse(
    @PackIdParam() packId: string,
    @ZodBody(ParseWords) body: z.infer<typeof ParseWords>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.words.parse(user, packId, body.text);
  }

  @ApiOperation({
    summary: 'CSV·XLSX 분석 (저장 안 함)',
    description: `5MB 이하. 1열 영어, 2열 뜻(쉼표로 여러 개). 형식은 확장자가 아니라 내용으로 판단. CSV는 UTF-8만, XLSX는 첫 번째 시트. 첫 행이 머리글(영어·단어 등)이면 건너뜀. ${WORD_FILE_MAX_ROWS}행까지. 응답은 텍스트 분석과 같음`,
  })
  @Post('import')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @ZodResponse(ParseResult)
  importFile(
    @PackIdParam() packId: string,
    @CurrentUser() user: AuthUser,
    @Req() request: FastifyRequest,
  ) {
    return this.words.importFile(user, packId, () => readUploadedFile(request));
  }

  @ApiOperation({ summary: '단어 수정' })
  @Patch(':wordId')
  @ZodResponse(WordItem)
  update(
    @PackIdParam() packId: string,
    @WordIdParam() wordId: string,
    @ZodBody(UpdateWord) body: z.infer<typeof UpdateWord>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.words.update(user, packId, wordId, body);
  }

  @ApiOperation({ summary: '단어 삭제' })
  @Delete(':wordId')
  @HttpCode(204)
  async remove(
    @PackIdParam() packId: string,
    @WordIdParam() wordId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.words.remove(user, packId, wordId);
  }
}
