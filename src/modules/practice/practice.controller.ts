import { Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { ZodBody, ZodParam, ZodResponse } from '../../common/zod/decorators.js';
import { CompletePractice, Practice, PracticeResult, StartPractice } from './practice.schemas.js';
import { PracticeService } from './practice.service.js';

@ApiTags('practice')
@Controller('practice/sessions')
export class PracticeController {
  constructor(private readonly practice: PracticeService) {}

  @ApiOperation({
    summary: '연습 시작',
    description:
      '혼자 하는 대결 연습. 4지선다, 문항과 정답을 함께 내려주고 시간은 클라이언트가 잰다. XP 없음. 단어 10개 이상(400 BATTLE_PACK_TOO_FEW_WORDS)',
  })
  @Auth('STUDENT')
  @Post()
  @ZodResponse(Practice, { status: 201 })
  start(
    @ZodBody(StartPractice) body: z.infer<typeof StartPractice>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.practice.start(user, body);
  }

  @ApiOperation({
    summary: '연습 끝내기',
    description:
      '대결과 같은 점수(정답 100 + 남은 시간 비례 보너스 최대 50). 제한 시간을 넘긴 답과 보내지 않은 문항은 미응답. 틀린 단어는 오답노트(출처 BATTLE). 다시 끝내면 409 BATTLE_PRACTICE_ALREADY_COMPLETED',
  })
  @Auth('STUDENT')
  @Post(':practiceId/complete')
  @HttpCode(200)
  @ZodResponse(PracticeResult)
  complete(
    @ZodParam('practiceId', z.uuid()) practiceId: string,
    @ZodBody(CompletePractice) body: z.infer<typeof CompletePractice>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.practice.complete(user, practiceId, body);
  }
}
