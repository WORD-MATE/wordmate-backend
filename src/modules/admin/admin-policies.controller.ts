import { Controller, Get, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodBody, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import {
  AdminPolicyList,
  AdminPolicyQuery,
  CreatePolicy,
  PolicyCreated,
} from './admin-policies.schemas.js';
import { AdminPoliciesService } from './admin-policies.service.js';

@ApiTags('admin')
@Auth('ADMIN')
@Controller('admin/policies')
export class AdminPoliciesController {
  constructor(private readonly policies: AdminPoliciesService) {}

  @ApiOperation({ summary: '약관 버전 목록', description: '시행 전 버전 포함' })
  @Get()
  @ZodResponse(AdminPolicyList)
  list(@ZodQuery(AdminPolicyQuery) query: z.infer<typeof AdminPolicyQuery>) {
    return this.policies.list(query.type);
  }

  @ApiOperation({
    summary: '약관 새 버전 등록',
    description:
      '시행일은 지금 이후. 시행일이 되면 현재 약관이 되고, 재동의가 필요하면 다음 요청부터 안내(서버마다 최대 1분 늦을 수 있음). 고지 공지는 따로 등록. 409 POLICY_VERSION_EXISTS',
  })
  @Post()
  @ZodResponse(PolicyCreated, { status: 201 })
  create(
    @ZodBody(CreatePolicy) body: z.infer<typeof CreatePolicy>,
    @Req() request: FastifyRequest,
  ) {
    return this.policies.create(request.user as AuthUser, body, request);
  }
}
