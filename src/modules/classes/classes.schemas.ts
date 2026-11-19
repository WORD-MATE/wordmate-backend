import { z } from 'zod';
import { NEXT_STEP } from '../../common/enums.js';
import { ClassSummary } from '../users/me.schema.js';

export const ClassListItem = z
  .object({
    classId: z.string(),
    grade: z.number().int(),
    classNo: z.number().int(),
    studentCount: z.number().int(),
  })
  .meta({ id: 'ClassListItem' });

export const ClassList = z.array(ClassListItem);

export const TeacherClassList = z.array(ClassSummary);

export const SetTeacherClasses = z
  .object({ classIds: z.array(z.uuid()).max(30) })
  .meta({ id: 'SetTeacherClasses' });

export const SetTeacherClassesResponse = z
  .object({ classes: z.array(ClassSummary), nextStep: z.enum(NEXT_STEP) })
  .meta({ id: 'SetTeacherClassesResponse' });
