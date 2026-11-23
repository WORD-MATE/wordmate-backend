import { Controller, Get, Put, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { SkipTeacherClassCheck } from '../../common/auth/onboarding.decorator.js';
import { ZodBody, ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import { NextStepService } from '../users/next-step.service.js';
import { TeacherClassService } from '../users/teacher-class.service.js';
import { ClassDashboardService } from './class-dashboard.service.js';
import {
  ClassDashboard,
  ClassList,
  ClassStudentList,
  DashboardQuery,
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

const CLASS_ERRORS =
  '403 CLASS_NOT_ASSIGNED(담당 반이 아님) / TEACHER_CLASS_REQUIRED, 404 CLASS_NOT_FOUND';

@ApiTags('classes')
@Auth('TEACHER', 'ADMIN')
@Controller('classes')
export class ClassDashboardController {
  constructor(private readonly dashboards: ClassDashboardService) {}

  @ApiOperation({
    summary: '반 학생 목록',
    description: `교사는 담당 반만, 관리자는 모든 반. 번호순. 이메일 등 개인정보 제외. 휴면·탈퇴 학생 제외. ${CLASS_ERRORS}`,
  })
  @Get(':classId/students')
  @ZodResponse(ClassStudentList)
  students(@ZodParam('classId', z.uuid()) classId: string, @Req() request: FastifyRequest) {
    return this.dashboards.students(currentUser(request), classId);
  }

  @ApiOperation({
    summary: '반 학습 대시보드',
    description: `이번 주(월요일부터)·이번 달(1일부터) 오늘까지(KST). 랭킹 공개 설정과 관계없이 보여줌. 400 VALIDATION_FAILED, ${CLASS_ERRORS}`,
  })
  @Get(':classId/dashboard')
  @ZodResponse(ClassDashboard)
  dashboard(
    @ZodParam('classId', z.uuid()) classId: string,
    @ZodQuery(DashboardQuery) query: z.infer<typeof DashboardQuery>,
    @Req() request: FastifyRequest,
  ) {
    return this.dashboards.dashboard(currentUser(request), classId, query.period);
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
