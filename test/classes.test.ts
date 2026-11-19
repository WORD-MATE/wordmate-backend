import { randomUUID } from 'node:crypto';
import { Controller, Get } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { auditLogs } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { DataGsmClient, type DataGsmProfile } from '../src/modules/auth/datagsm/datagsm.client.js';
import { createTestApp, inject } from './support/create-test-app.js';
import { TEST_REDIRECT_URI } from './support/test-env.js';

@Controller('test-classes')
class ProtectedController {
  @Get()
  protectedRoute() {
    return { ok: true };
  }
}

const teacherProfile: DataGsmProfile = {
  datagsmId: randomUUID(),
  email: null,
  role: 'TEACHER',
  name: '김교사',
  studentNumber: null,
  grade: null,
  classNo: null,
  number: null,
  inactive: false,
  pending: false,
};

const studentProfile: DataGsmProfile = {
  datagsmId: randomUUID(),
  email: null,
  role: 'STUDENT',
  name: '반학생',
  studentNumber: '3901',
  grade: 3,
  classNo: 9,
  number: 1,
  inactive: false,
  pending: false,
};

interface ClassItem {
  classId: string;
  grade: number;
  classNo: number;
  studentCount: number;
}

describe('학급·교사 담당 반', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let profile: DataGsmProfile;
  let loginCount = 0;
  let teacherToken: string;
  let studentToken: string;

  // 테스트끼리 로그인 요청 제한을 나눠 쓰지 않게 요청마다 IP를 바꾼다
  const login = async (next: DataGsmProfile) => {
    profile = next;
    const res = await inject(app, {
      method: 'POST',
      url: '/auth/datagsm',
      remoteAddress: `10.2.0.${++loginCount}`,
      payload: { code: 'c', codeVerifier: 'v'.repeat(43), redirectUri: TEST_REDIRECT_URI },
    });
    return res.json();
  };

  const call = (token: string, url: string, method: 'GET' | 'PUT' = 'GET', payload?: object) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: `Bearer ${token}` },
    });

  const setClasses = (classIds: string[]) =>
    call(teacherToken, '/teachers/me/classes', 'PUT', { classIds });

  const classList = async (): Promise<ClassItem[]> => (await call(teacherToken, '/classes')).json();

  const findClass = async (grade: number, classNo: number) => {
    const found = (await classList()).find((c) => c.grade === grade && c.classNo === classNo);
    if (!found) throw new Error(`${grade}-${classNo} 반이 없습니다`);
    return found;
  };

  beforeAll(async () => {
    app = await createTestApp({
      controllers: [ProtectedController],
      overrides: [
        [DataGsmClient, { exchangeCode: async () => 'at', getProfile: async () => profile }],
      ],
    });
    db = app.get(DB);
    studentToken = (await login(studentProfile)).accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('담당 반이 없는 교사는 로그인 nextStep이 TEACHER_CLASS_SELECT', async () => {
    const body = await login(teacherProfile);
    expect(body.nextStep).toBe('TEACHER_CLASS_SELECT');
    expect(body.user.teacherClasses).toEqual([]);
    teacherToken = body.accessToken;
  });

  it('반을 고르기 전에는 일반 API가 403 TEACHER_CLASS_REQUIRED, 반 선택에 필요한 API는 호출 가능', async () => {
    const blocked = await call(teacherToken, '/test-classes');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('TEACHER_CLASS_REQUIRED');

    expect((await call(teacherToken, '/users/me')).statusCode).toBe(200);
    expect((await call(teacherToken, '/teachers/me/classes')).json()).toEqual([]);
    expect((await call(studentToken, '/test-classes')).statusCode).toBe(200);
  });

  it('학급 목록은 미리 만든 1~3학년 1~4반과 학생 로그인으로 생긴 반을 학생 수와 함께 보여준다', async () => {
    const list = await classList();
    for (let grade = 1; grade <= 3; grade++) {
      for (let classNo = 1; classNo <= 4; classNo++) {
        expect(list).toContainEqual(expect.objectContaining({ grade, classNo }));
      }
    }
    expect(await findClass(3, 9)).toMatchObject({ studentCount: 1 });
    expect((await call(studentToken, '/classes')).statusCode).toBe(403);
  });

  it('빈 배열은 400 CLASS_REQUIRED, 없는 반은 400 CLASS_NOT_FOUND, 학생은 403', async () => {
    const empty = await setClasses([]);
    expect(empty.statusCode).toBe(400);
    expect(empty.json().code).toBe('CLASS_REQUIRED');

    const unknown = newId();
    const missing = await setClasses([unknown]);
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({
      code: 'CLASS_NOT_FOUND',
      detail: { classIds: [unknown] },
    });

    const byStudent = await call(studentToken, '/teachers/me/classes', 'PUT', { classIds: [] });
    expect(byStudent.statusCode).toBe(403);
    expect(byStudent.json().code).toBe('FORBIDDEN');
  });

  it('담당 반을 고르면 nextStep HOME, 이후 일반 API 호출 가능, 변경 이력이 감사 로그에 남는다', async () => {
    const a = await findClass(2, 1);
    const b = await findClass(1, 3);
    const res = await setClasses([a.classId, b.classId, a.classId]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      classes: [
        { classId: b.classId, grade: 1, classNo: 3 },
        { classId: a.classId, grade: 2, classNo: 1 },
      ],
      nextStep: 'HOME',
    });

    expect((await call(teacherToken, '/test-classes')).statusCode).toBe(200);
    expect((await call(teacherToken, '/users/me')).json().teacherClasses).toHaveLength(2);

    const logs = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'TEACHER_CLASS_CHANGE'));
    expect(logs).toContainEqual(
      expect.objectContaining({
        targetType: 'USER',
        detail: { before: [], after: [a.classId, b.classId] },
      }),
    );
  });

  it('다시 설정하면 전체 교체된다', async () => {
    const c = await findClass(3, 4);
    const res = await setClasses([c.classId]);
    expect(res.json().classes).toEqual([{ classId: c.classId, grade: 3, classNo: 4 }]);
    expect((await call(teacherToken, '/teachers/me/classes')).json()).toHaveLength(1);
  });
});
