import { Controller, Get, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { SkipTeacherClassCheck } from '../../common/auth/onboarding.decorator.js';
import { ZodBody, ZodResponse } from '../../common/zod/decorators.js';
import { NextStepService } from '../users/next-step.service.js';
import { TeacherClassService } from '../users/teacher-class.service.js';
import {
  ClassList,
  SetTeacherClasses,
  SetTeacherClassesResponse,
  TeacherClassList,
} from './classes.schemas.js';
import { ClassesService } from './classes.service.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;

@ApiTags('classes')
@Auth('TEACHER', 'ADMIN')
@SkipTeacherClassCheck()
@Controller('classes')
export class ClassesController {
  constructor(private readonly classes: ClassesService) {}

  @ApiOperation({
    summary: '학급 목록',
    description: '담당 반 선택용. 반을 고르기 전에도 호출 가능',
  })
  @Get()
  @ZodResponse(ClassList)
  list() {
    return this.classes.list();
  }
}

@ApiTags('teachers')
@Auth('TEACHER')
@SkipTeacherClassCheck()
@Controller('teachers/me')
export class TeachersController {
  constructor(
    private readonly classes: ClassesService,
    private readonly teacherClasses: TeacherClassService,
    private readonly nextStep: NextStepService,
  ) {}

  @ApiOperation({ summary: '내 담당 반' })
  @Get('classes')
  @ZodResponse(TeacherClassList)
  myClasses(@Req() request: FastifyRequest) {
    return this.teacherClasses.list(currentUser(request).userId);
  }

  @ApiOperation({
    summary: '담당 반 설정',
    description: '전체 교체. 첫 로그인 후 반 선택에도 사용하며 다음 단계를 돌려줌',
  })
  @Put('classes')
  @ZodResponse(SetTeacherClassesResponse)
  async setMyClasses(
    @ZodBody(SetTeacherClasses) body: z.infer<typeof SetTeacherClasses>,
    @Req() request: FastifyRequest,
  ) {
    const user = currentUser(request);
    const classes = await this.classes.setTeacherClasses(user.userId, body.classIds, request);
    return { classes, nextStep: await this.nextStep.resolve(user) };
  }
}
