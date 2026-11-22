import type { User } from '../../infra/db/schema/index.js';
import type { DataGsmStudent } from '../auth/datagsm/datagsm.client.js';

export type SyncUser = Pick<
  User,
  'status' | 'name' | 'studentNumber' | 'grade' | 'classNo' | 'number' | 'datagsmStudentId'
>;

export interface SyncPlan {
  changes: Partial<SyncUser>;
  deactivate: boolean;
  reactivate: boolean;
  classChanged: boolean;
  /** 재학생인데 학번이 비어 있어 학적을 그대로 둔 경우 */
  incomplete: boolean;
}

/**
 * 한 사용자에 DataGSM 학적을 맞춘다. 탈퇴한 사용자는 건드리지 않고(null),
 * 정지된 사용자는 학적만 바꾸고 상태는 그대로 둔다
 */
export function planSync(user: SyncUser, student: DataGsmStudent): SyncPlan | null {
  if (user.status === 'WITHDRAWN') return null;

  const next: Partial<SyncUser> = { name: student.name };
  if (student.studentId) next.datagsmStudentId = student.studentId;

  // 졸업·자퇴하면 학년·반이 비고, 재학생도 DataGSM 관리자가 정보 수정을 요청하면 다시 입력할 때까지 비므로
  // 셋 다 있을 때만 바꾼다 (졸업생은 마지막 학년·반을 남긴다)
  const complete = student.grade !== null && student.classNo !== null && student.number !== null;
  if (complete) {
    next.grade = student.grade;
    next.classNo = student.classNo;
    next.number = student.number;
    next.studentNumber = student.studentNumber;
  }

  let deactivate = false;
  let reactivate = false;
  if (student.inactive && user.status === 'ACTIVE') {
    next.status = 'INACTIVE';
    deactivate = true;
  } else if (!student.inactive && user.status === 'INACTIVE') {
    next.status = 'ACTIVE';
    reactivate = true;
  }

  const changes = Object.fromEntries(
    Object.entries(next).filter(([key, value]) => user[key as keyof SyncUser] !== value),
  ) as Partial<SyncUser>;

  return {
    changes,
    deactivate,
    reactivate,
    classChanged: 'grade' in changes || 'classNo' in changes,
    incomplete: !complete && !student.inactive,
  };
}

/** 재학생의 반 목록 (중복 없이) */
export function classesOf(students: DataGsmStudent[]): { grade: number; classNo: number }[] {
  const seen = new Map<string, { grade: number; classNo: number }>();
  for (const s of students) {
    if (s.inactive || s.grade === null || s.classNo === null) continue;
    seen.set(`${s.grade}-${s.classNo}`, { grade: s.grade, classNo: s.classNo });
  }
  return [...seen.values()];
}
