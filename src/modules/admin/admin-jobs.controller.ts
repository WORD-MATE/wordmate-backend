import { Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { JOB, JOB_RUN_STATUS, JOB_TRIGGER, type Job } from '../../common/enums.js';
import { ZodParam, ZodResponse } from '../../common/zod/decorators.js';
import { AdminJobsService } from './admin-jobs.service.js';

const JobList = z
  .array(
    z.object({
      job: z.enum(JOB),
      schedule: z.string().describe('주기 (KST)'),
      lastRunAt: z.iso.datetime().nullable(),
      lastStatus: z.enum(JOB_RUN_STATUS).nullable(),
      lastTrigger: z.enum(JOB_TRIGGER).nullable(),
      lastError: z.string().nullable(),
      nextRunAt: z.iso.datetime().nullable().describe('다음 정기 실행 (못 읽으면 null)'),
    }),
  )
  .meta({ id: 'AdminJobList' });

const JobQueued = z
  .object({ job: z.enum(JOB), queuedAt: z.iso.datetime() })
  .meta({ id: 'AdminJobQueued' });

@ApiTags('admin')
@Auth('ADMIN')
@Controller('admin/jobs')
export class AdminJobsController {
  constructor(private readonly jobs: AdminJobsService) {}

  @ApiOperation({
    summary: '정기 작업 상태',
    description: '주기, 마지막 실행·상태·오류, 다음 실행',
  })
  @Get()
  @ZodResponse(JobList)
  list() {
    return this.jobs.list();
  }

  @ApiOperation({
    summary: '정기 작업 수동 실행',
    description: '큐에 넣고 바로 202. 409 ADMIN_JOB_RUNNING(실행 중이거나 방금 실행함)',
  })
  @Post(':job/run')
  @HttpCode(202)
  @ZodResponse(JobQueued, { status: 202 })
  run(@ZodParam('job', z.enum(JOB)) job: Job, @Req() request: FastifyRequest) {
    return this.jobs.run(request.user as AuthUser, job, request);
  }
}
