import { Inject, Injectable } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import { type Database, DB } from '../../infra/db/db.module.js';
import { classes, teacherClasses } from '../../infra/db/schema/index.js';
import type { ClassSummary } from './me.schema.js';

@Injectable()
export class TeacherClassService {
  constructor(@Inject(DB) private readonly db: Database) {}

  list(teacherId: string): Promise<ClassSummary[]> {
    return this.db
      .select({ classId: classes.id, grade: classes.grade, classNo: classes.classNo })
      .from(teacherClasses)
      .innerJoin(classes, eq(classes.id, teacherClasses.classId))
      .where(eq(teacherClasses.teacherId, teacherId))
      .orderBy(asc(classes.grade), asc(classes.classNo));
  }

  async has(teacherId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ classId: teacherClasses.classId })
      .from(teacherClasses)
      .where(eq(teacherClasses.teacherId, teacherId))
      .limit(1);
    return row !== undefined;
  }
}
