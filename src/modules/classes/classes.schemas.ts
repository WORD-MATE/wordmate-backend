import { z } from 'zod';
import { DASHBOARD_PERIOD, NEXT_STEP } from '../../common/enums.js';
import { ClassSummary } from '../users/me.schema.js';
import { UserSummary } from '../users/user-summary.js';

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

export const ClassStudent = z
  .object({
    user: UserSummary,
    studentNumber: z.string().nullable(),
    number: z.number().int().nullable(),
    lastStudiedAt: z.iso.datetime().nullable().describe('마지막으로 학습을 끝낸 시각'),
  })
  .meta({ id: 'ClassStudent' });

export const ClassStudentList = z.array(ClassStudent);

export const DashboardQuery = z.object({ period: z.enum(DASHBOARD_PERIOD) });

export const ClassDashboard = z
  .object({
    class: ClassSummary,
    period: z.enum(DASHBOARD_PERIOD),
    from: z.iso.date().describe('기간 첫날 (KST, 이번 주 월요일 또는 이번 달 1일)'),
    to: z.iso.date().describe('오늘 (KST)'),
    summary: z.object({
      studentCount: z.number().int(),
      participationRate: z.number().describe('기간 안에 학습한 학생 비율 (0~100, 소수 첫째 자리)'),
      avgAccuracy: z.number().nullable().describe('정답률이 있는 학생들의 정답률 평균'),
    }),
    students: z.array(
      z.object({
        user: UserSummary,
        studentNumber: z.string().nullable(),
        participated: z.boolean(),
        studiedWordCount: z.number().int(),
        accuracy: z.number().nullable().describe('4지선다·직접 입력 답만, 없으면 null'),
        streak: z.number().int().describe('현재 연속 학습일'),
        battleCount: z.number().int(),
        battleWinCount: z.number().int(),
      }),
    ),
    frequentWrongWords: z
      .array(
        z.object({
          wordId: z.string(),
          english: z.string(),
          meanings: z.array(z.string()),
          wrongStudentCount: z.number().int(),
        }),
      )
      .describe('기간 안에 틀린 학생이 많은 단어 상위 10개'),
  })
  .meta({ id: 'ClassDashboard' });
export type ClassDashboard = z.infer<typeof ClassDashboard>;
