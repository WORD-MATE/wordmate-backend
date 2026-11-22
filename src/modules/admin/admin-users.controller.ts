import { Controller, Get, HttpCode, Patch, Post, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { Idempotent } from '../../common/idempotency/idempotent.decorator.js';
import { ZodBody, ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import { TeacherClassList } from '../classes/classes.schemas.js';
import { SetUserStatus } from './admin-sanctions.schemas.js';
import { AdminSanctionsService } from './admin-sanctions.service.js';
import {
  AdminUserDetail,
  AdminUserPage,
  AdminUserQuery,
  SetAdmin,
  SetUserClasses,
  XpAdjustment,
  XpAdjustmentResult,
} from './admin-users.schemas.js';
import { AdminUsersService } from './admin-users.service.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;
const UserIdParam = () => ZodParam('userId', z.uuid());

@ApiTags('admin')
@Auth('ADMIN')
@Controller('admin/users')
export class AdminUsersController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly sanctions: AdminSanctionsService,
  ) {}

  @ApiOperation({ summary: '사용자 검색', description: '조회도 감사 로그에 남김. 최신 가입순' })
  @Get()
  @ZodResponse(AdminUserPage)
  search(
    @ZodQuery(AdminUserQuery) query: z.infer<typeof AdminUserQuery>,
    @Req() request: FastifyRequest,
  ) {
    return this.users.search(currentUser(request), query, request);
  }

  @ApiOperation({
    summary: '사용자 상세',
    description: '조회도 감사 로그에 남김. 404 USER_NOT_FOUND(없거나 탈퇴)',
  })
  @Get(':userId')
  @ZodResponse(AdminUserDetail)
  detail(@UserIdParam() userId: string, @Req() request: FastifyRequest) {
    return this.users.detail(currentUser(request), userId, request);
  }

  @ApiOperation({
    summary: '계정 정지·해제',
    description:
      '정지는 제재(SUSPEND, 기간이 없으면 BAN)와 같은 처리: 모든 세션 폐기. 해제는 정지만 품. 409 ADMIN_SELF_ACTION / ADMIN_NOT_SUSPENDED, 404 USER_NOT_FOUND',
  })
  @Patch(':userId/status')
  @HttpCode(204)
  @Idempotent()
  async setStatus(
    @UserIdParam() userId: string,
    @ZodBody(SetUserStatus) body: z.infer<typeof SetUserStatus>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    const admin = currentUser(request);
    if (body.status === 'ACTIVE') {
      await this.sanctions.unsuspend(admin, userId, body.reason, request);
      return;
    }
    await this.sanctions.apply(
      admin,
      {
        userId,
        type: body.suspendedUntil ? 'SUSPEND' : 'BAN',
        reason: body.reason,
        suspendedUntil: body.suspendedUntil ?? undefined,
      },
      request,
    );
  }

  @ApiOperation({
    summary: '관리자 권한 부여·회수',
    description:
      '교사만 부여(409 ADMIN_NOT_TEACHER). 마지막 관리자는 회수 불가 409 ADMIN_LAST_ADMIN',
  })
  @Put(':userId/admin')
  @HttpCode(204)
  async setAdmin(
    @UserIdParam() userId: string,
    @ZodBody(SetAdmin) body: z.infer<typeof SetAdmin>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.users.setAdmin(currentUser(request), userId, body.isAdmin, request);
  }

  @ApiOperation({
    summary: '교사 담당 반 수정',
    description: '전체 교체. 400 CLASS_NOT_FOUND, 409 ADMIN_NOT_TEACHER',
  })
  @Put(':userId/classes')
  @ZodResponse(TeacherClassList)
  setClasses(
    @UserIdParam() userId: string,
    @ZodBody(SetUserClasses) body: z.infer<typeof SetUserClasses>,
    @Req() request: FastifyRequest,
  ) {
    return this.users.setClasses(currentUser(request), userId, body.classIds, request);
  }

  @ApiOperation({
    summary: 'XP 조정',
    description:
      '사유 필수. 하루 상한 미적용(상한 계산에도 안 들어감), XP 내역에 ADMIN_ADJUST. 400 ADMIN_XP_NEGATIVE(조정 뒤 0 미만)',
  })
  @Post(':userId/xp-adjustments')
  @HttpCode(200)
  @Idempotent()
  @ZodResponse(XpAdjustmentResult)
  adjustXp(
    @UserIdParam() userId: string,
    @ZodBody(XpAdjustment) body: z.infer<typeof XpAdjustment>,
    @Req() request: FastifyRequest,
  ) {
    return this.users.adjustXp(currentUser(request), userId, body, request);
  }
}
