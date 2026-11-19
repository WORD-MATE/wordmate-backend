import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { AuditLogService } from '../../common/audit/audit-log.service.js';
import { AppException } from '../../common/errors/app-exception.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { classes, teacherClasses, users } from '../../infra/db/schema/index.js';
import type { ClassSummary } from '../users/me.schema.js';
import { TeacherClassService } from '../users/teacher-class.service.js';

export const ClassErrors = {
  required: () =>
    new AppException(
      'CLASS_REQUIRED',
      '담당 반을 1개 이상 선택해야 합니다.',
      HttpStatus.BAD_REQUEST,
    ),
  notFound: (classIds: string[]) =>
    new AppException('CLASS_NOT_FOUND', '존재하지 않는 반입니다.', HttpStatus.BAD_REQUEST, {
      classIds,
    }),
};

@Injectable()
export class ClassesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly teacherClasses: TeacherClassService,
    private readonly audit: AuditLogService,
  ) {}

  list() {
    return this.db
      .select({
        classId: classes.id,
        grade: classes.grade,
        classNo: classes.classNo,
        studentCount: count(users.id),
      })
      .from(classes)
      .leftJoin(
        users,
        and(
          eq(users.grade, classes.grade),
          eq(users.classNo, classes.classNo),
          eq(users.role, 'STUDENT'),
          eq(users.status, 'ACTIVE'),
        ),
      )
      .groupBy(classes.id, classes.grade, classes.classNo)
      .orderBy(asc(classes.grade), asc(classes.classNo));
  }

  async setTeacherClasses(
    teacherId: string,
    classIds: string[],
    request: FastifyRequest,
  ): Promise<ClassSummary[]> {
    const ids = [...new Set(classIds)];
    if (ids.length === 0) throw ClassErrors.required();

    const found = await this.db
      .select({ id: classes.id })
      .from(classes)
      .where(inArray(classes.id, ids));
    const missing = ids.filter((id) => !found.some((row) => row.id === id));
    if (missing.length > 0) throw ClassErrors.notFound(missing);

    const before = await this.teacherClasses.list(teacherId);
    await this.db.transaction(async (tx) => {
      await tx.delete(teacherClasses).where(eq(teacherClasses.teacherId, teacherId));
      await tx.insert(teacherClasses).values(ids.map((classId) => ({ teacherId, classId })));
      await this.audit.record(
        {
          actorId: teacherId,
          action: 'TEACHER_CLASS_CHANGE',
          targetType: 'USER',
          targetId: teacherId,
          detail: { before: before.map((c) => c.classId), after: ids },
        },
        request,
        tx,
      );
    });

    return this.teacherClasses.list(teacherId);
  }
}
