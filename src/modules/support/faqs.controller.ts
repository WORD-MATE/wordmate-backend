import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import { AllowDuringMaintenance } from '../../common/client/client.decorators.js';
import { ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import { FaqList, FaqQuery } from './faqs.schemas.js';
import { FaqsService } from './faqs.service.js';

@ApiTags('support')
@Auth('ALL')
@AllowDuringMaintenance()
@Controller('faqs')
export class FaqsController {
  constructor(private readonly faqs: FaqsService) {}

  @ApiOperation({
    summary: 'FAQ 목록',
    description: '로그인 없이. 분류 순, 분류 안에서는 순서대로',
  })
  @Get()
  @ZodResponse(FaqList)
  list(@ZodQuery(FaqQuery) query: z.infer<typeof FaqQuery>) {
    return this.faqs.list(query.category);
  }
}
