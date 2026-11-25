import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ZodBody, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import {
  DeletedCount,
  GraduatedCount,
  MAX_BULK_WRONG_NOTES,
  WrongNoteIds,
  WrongNoteListQuery,
  WrongNotePage,
} from './wrong-notes.schemas.js';
import { WrongNotesService } from './wrong-notes.service.js';

@ApiTags('wrong-notes')
@Controller('wrong-notes')
export class WrongNotesController {
  constructor(private readonly wrongNotes: WrongNotesService) {}

  @ApiOperation({
    summary: '오답 목록',
    description:
      '(단어, 문제 유형)마다 한 항목. 기본은 ACTIVE·최근에 틀린 순. 같은 방식으로 2번 연속 맞히면 자동 졸업(GRADUATED). 삭제된 단어는 빠짐. 다시 풀기: POST /study/sessions (source=WRONG_NOTE, wordIds)',
  })
  @Get()
  @ZodResponse(WrongNotePage)
  list(
    @ZodQuery(WrongNoteListQuery) query: z.infer<typeof WrongNoteListQuery>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.wrongNotes.list(user, query);
  }

  @ApiOperation({
    summary: '오답 일괄 영구 삭제',
    description: `복구 불가. 한 번에 ${MAX_BULK_WRONG_NOTES}개까지. 남의 id는 무시`,
  })
  @Post('delete')
  @HttpCode(200)
  @ZodResponse(DeletedCount)
  remove(@ZodBody(WrongNoteIds) body: z.infer<typeof WrongNoteIds>, @CurrentUser() user: AuthUser) {
    return this.wrongNotes.remove(user, body);
  }

  @ApiOperation({
    summary: '오답 일괄 졸업',
    description: `목록에서 숨기고 기록은 보관(GRADUATED). 다시 틀리면 ACTIVE로 돌아옴. 한 번에 ${MAX_BULK_WRONG_NOTES}개까지`,
  })
  @Post('graduate')
  @HttpCode(200)
  @ZodResponse(GraduatedCount)
  graduate(
    @ZodBody(WrongNoteIds) body: z.infer<typeof WrongNoteIds>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.wrongNotes.graduate(user, body);
  }
}
