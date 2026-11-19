import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import { AllowDuringMaintenance } from '../../common/client/client.decorators.js';
import { POLICY_TYPE, type PolicyType } from '../../common/enums.js';
import { ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import { PoliciesService } from './policies.service.js';

const PolicyQuery = z.object({ version: z.string().max(20).optional() });

const PolicyDetail = z
  .object({
    type: z.enum(POLICY_TYPE),
    version: z.string(),
    title: z.string(),
    effectiveAt: z.iso.datetime(),
    content: z.string(),
    history: z.array(z.object({ version: z.string(), effectiveAt: z.iso.datetime() })),
  })
  .meta({ id: 'PolicyDetail' });

@ApiTags('policies')
@Auth('ALL')
@AllowDuringMaintenance()
@Controller('policies')
export class PoliciesController {
  constructor(private readonly policies: PoliciesService) {}

  @ApiOperation({
    summary: '약관 전문과 버전 이력',
    description: 'version을 생략하면 현재 시행 중인 버전 (내용은 Markdown)',
  })
  @Get(':type')
  @ZodResponse(PolicyDetail)
  find(
    @ZodParam('type', z.enum(POLICY_TYPE)) type: PolicyType,
    @ZodQuery(PolicyQuery) query: z.infer<typeof PolicyQuery>,
  ) {
    return this.policies.find(type, query.version);
  }
}
