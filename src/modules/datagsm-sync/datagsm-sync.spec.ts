import { describe, expect, it } from 'vitest';
import type { DataGsmStudent } from '../auth/datagsm/datagsm.client.js';
import { classesOf, planSync, type SyncUser } from './datagsm-sync.js';

const user: SyncUser = {
  status: 'ACTIVE',
  name: '김학생',
  studentNumber: '2307',
  grade: 2,
  classNo: 3,
  number: 7,
  datagsmStudentId: '11',
};

const student: DataGsmStudent = {
  studentId: '11',
  email: 's@gsm.hs.kr',
  name: '김학생',
  studentNumber: '2307',
  grade: 2,
  classNo: 3,
  number: 7,
  inactive: false,
};

const graduate: DataGsmStudent = {
  ...student,
  studentNumber: null,
  grade: null,
  classNo: null,
  number: null,
  inactive: true,
};

describe('planSync', () => {
  it('바뀐 것이 없으면 변경 없음', () => {
    expect(planSync(user, student)).toEqual({
      changes: {},
      deactivate: false,
      reactivate: false,
      classChanged: false,
      incomplete: false,
    });
  });

  it('진급·반 변경은 학번까지 바꾸고 반 변경으로 표시한다', () => {
    const plan = planSync(user, {
      ...student,
      studentNumber: '3101',
      grade: 3,
      classNo: 1,
      number: 1,
    });
    expect(plan?.changes).toEqual({ studentNumber: '3101', grade: 3, classNo: 1, number: 1 });
    expect(plan?.classChanged).toBe(true);
  });

  it('번호만 바뀌면 반 변경이 아니다', () => {
    const plan = planSync(user, { ...student, number: 8, studentNumber: '2308' });
    expect(plan?.changes).toEqual({ number: 8, studentNumber: '2308' });
    expect(plan?.classChanged).toBe(false);
  });

  it('졸업·자퇴는 휴면으로 바꾸고 마지막 학년·반은 남긴다', () => {
    expect(planSync(user, graduate)).toEqual({
      changes: { status: 'INACTIVE' },
      deactivate: true,
      reactivate: false,
      classChanged: false,
      incomplete: false,
    });
  });

  it('휴면이던 학생이 재학으로 나오면 다시 활동으로', () => {
    const plan = planSync({ ...user, status: 'INACTIVE' }, student);
    expect(plan?.changes).toEqual({ status: 'ACTIVE' });
    expect(plan?.reactivate).toBe(true);
  });

  it('이미 휴면인 졸업생은 그대로', () => {
    expect(planSync({ ...user, status: 'INACTIVE' }, graduate)?.changes).toEqual({});
  });

  it('정지된 학생은 학적만 바꾸고 상태는 그대로 둔다', () => {
    const suspended = { ...user, status: 'SUSPENDED' as const };
    expect(planSync(suspended, graduate)?.changes).toEqual({});
    expect(planSync(suspended, { ...student, classNo: 4 })?.changes).toEqual({ classNo: 4 });
  });

  it('탈퇴한 사용자는 건드리지 않는다', () => {
    expect(planSync({ ...user, status: 'WITHDRAWN' }, graduate)).toBeNull();
  });

  it('재학생인데 학번이 비어 있으면 학적을 그대로 두고 건너뜀으로 표시한다', () => {
    const plan = planSync(user, { ...student, grade: null, classNo: null, number: null });
    expect(plan?.changes).toEqual({});
    expect(plan?.incomplete).toBe(true);
  });

  it('이름과 학생 ID를 맞춘다 (이메일로 찾은 사용자)', () => {
    expect(
      planSync({ ...user, datagsmStudentId: null }, { ...student, name: '김바뀜' })?.changes,
    ).toEqual({ name: '김바뀜', datagsmStudentId: '11' });
  });
});

describe('classesOf', () => {
  it('재학생의 반만 중복 없이', () => {
    expect(
      classesOf([
        student,
        { ...student, studentId: '12' },
        { ...student, studentId: '13', grade: 1, classNo: 2 },
        { ...student, studentId: '14', classNo: null },
        { ...graduate, grade: 3, classNo: 4 },
      ]),
    ).toEqual([
      { grade: 2, classNo: 3 },
      { grade: 1, classNo: 2 },
    ]);
  });
});
