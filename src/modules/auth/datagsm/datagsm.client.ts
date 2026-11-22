import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { Role } from '../../../common/enums.js';
import { AppException } from '../../../common/errors/app-exception.js';
import type { Env } from '../../../config/env.js';

const TIMEOUT_MS = 5000;

const TokenResponse = z.object({ access_token: z.string().min(1) });

const Student = z.object({
  id: z.number().int().nullish(),
  name: z.string(),
  email: z.string().nullish(),
  grade: z.number().int().nullish(),
  classNum: z.number().int().nullish(),
  number: z.number().int().nullish(),
  studentNumber: z.number().int().nullish(),
  role: z.string().nullish(),
});

const UserInfo = z.object({
  id: z.number().int(),
  email: z.string().nullish(),
  status: z.string().nullish(),
  objectType: z.enum(['STUDENT', 'TEACHER']),
  student: Student.nullish(),
  teacher: z.object({ name: z.string() }).nullish(),
});

const ListedStudent = Student.extend({ id: z.number().int() });

const StudentPage = z.object({
  data: z.object({
    totalPages: z.number().int(),
    students: z.array(z.unknown()),
  }),
});

/** 학적 정보. 로그인과 학적 동기화가 같은 규칙으로 바꾼다 */
export interface DataGsmStudent {
  /** 학생 ID (계정 ID와 다르다) */
  studentId: string | null;
  email: string | null;
  name: string;
  studentNumber: string | null;
  grade: number | null;
  classNo: number | null;
  number: number | null;
  /** 졸업·자퇴 */
  inactive: boolean;
}

export interface DataGsmProfile extends Omit<DataGsmStudent, 'studentId'> {
  datagsmId: string;
  datagsmStudentId?: string | null;
  role: Role;
  /** DataGSM 가입 승인 대기 */
  pending: boolean;
}

const STUDENT_PAGE_SIZE = 1000;
/** 페이지 수가 비정상적으로 커도 끝없이 돌지 않게 */
const MAX_STUDENT_PAGES = 50;
const LIST_TIMEOUT_MS = 15_000;

const INACTIVE_STUDENT_ROLES = new Set(['GRADUATE', 'WITHDRAWN']);

export const DataGsmErrors = {
  failed: (reason: string) =>
    new AppException(
      'AUTH_DATAGSM_FAILED',
      'DataGSM 인증에 실패했습니다. 다시 로그인해 주세요.',
      HttpStatus.UNAUTHORIZED,
      { reason },
    ),
  unavailable: (reason: string) =>
    new AppException(
      'DATAGSM_UNAVAILABLE',
      'DataGSM에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.',
      HttpStatus.BAD_GATEWAY,
      { reason },
    ),
};

@Injectable()
export class DataGsmClient {
  private readonly logger = new Logger(DataGsmClient.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  async exchangeCode(input: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<string> {
    const body = await this.request(
      `${this.config.get('DATAGSM_AUTH_URL', { infer: true })}/v1/oauth/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: input.code,
          code_verifier: input.codeVerifier,
          redirect_uri: input.redirectUri,
          client_id: this.config.get('DATAGSM_CLIENT_ID', { infer: true }),
        }),
      },
      'token',
    );
    const parsed = TokenResponse.safeParse(body);
    if (!parsed.success) throw DataGsmErrors.unavailable('INVALID_TOKEN_RESPONSE');
    return parsed.data.access_token;
  }

  async getProfile(accessToken: string): Promise<DataGsmProfile> {
    const body = await this.request(
      `${this.config.get('DATAGSM_RESOURCE_URL', { infer: true })}/userinfo`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      'userinfo',
    );
    const parsed = UserInfo.safeParse(body);
    if (!parsed.success) throw DataGsmErrors.unavailable('INVALID_USERINFO_RESPONSE');
    return toProfile(parsed.data);
  }

  /**
   * 졸업생·자퇴생을 포함한 전체 학생 (OpenAPI GET /v1/students, X-API-KEY).
   * 중간 페이지가 실패하면 일부만 반영되지 않게 전체를 실패시킨다. API 키가 없으면 null
   */
  async listStudents(): Promise<DataGsmStudent[] | null> {
    const apiKey = this.config.get('DATAGSM_API_KEY', { infer: true });
    if (!apiKey) return null;
    const base = this.config.get('DATAGSM_OPENAPI_URL', { infer: true });
    const students: DataGsmStudent[] = [];
    for (let page = 0; page < MAX_STUDENT_PAGES; page++) {
      const query = new URLSearchParams({
        includeGraduates: 'true',
        includeWithdrawn: 'true',
        sortBy: 'ID',
        sortDirection: 'ASC',
        page: String(page),
        size: String(STUDENT_PAGE_SIZE),
      });
      let response: Response;
      try {
        response = await fetch(`${base}/v1/students?${query}`, {
          headers: { 'X-API-KEY': apiKey },
          signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
        });
      } catch (error) {
        throw new Error(`DataGSM 학생 목록 요청 실패: ${String(error)}`);
      }
      if (!response.ok) throw new Error(`DataGSM 학생 목록 응답 HTTP ${response.status}`);
      const parsed = StudentPage.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new Error('DataGSM 학생 목록 응답 형식이 다릅니다.');
      // 형식이 틀린 학생 하나 때문에 전체 동기화가 매일 실패하지 않게 그 학생만 건너뛴다
      let invalid = 0;
      for (const item of parsed.data.data.students) {
        const student = ListedStudent.safeParse(item);
        if (student.success) students.push(toStudent(student.data));
        else invalid++;
      }
      if (invalid > 0) {
        this.logger.warn(
          `DataGSM 학생 목록 ${page + 1}페이지에서 형식이 틀린 ${invalid}명을 건너뜀`,
        );
      }
      if (page + 1 >= parsed.data.data.totalPages) return students;
    }
    throw new Error(`DataGSM 학생 목록이 ${MAX_STUDENT_PAGES}페이지를 넘습니다.`);
  }

  private async request(url: string, init: RequestInit, label: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      this.logger.warn(`DataGSM ${label} 요청 실패: ${String(error)}`);
      throw DataGsmErrors.unavailable('NETWORK');
    }

    if (response.status >= 500 || response.status === 429) {
      this.logger.warn(`DataGSM ${label} 응답 ${response.status}`);
      throw DataGsmErrors.unavailable(`HTTP_${response.status}`);
    }
    if (!response.ok) {
      throw DataGsmErrors.failed(`HTTP_${response.status}`);
    }
    return response.json().catch(() => null);
  }
}

function toProfile(info: z.infer<typeof UserInfo>): DataGsmProfile {
  const base = {
    datagsmId: String(info.id),
    email: info.email ?? null,
    pending: info.status === 'PENDING',
  };

  if (info.objectType === 'TEACHER') {
    if (!info.teacher) throw DataGsmErrors.unavailable('MISSING_TEACHER_PROFILE');
    return {
      ...base,
      datagsmStudentId: null,
      role: 'TEACHER',
      name: info.teacher.name,
      studentNumber: null,
      grade: null,
      classNo: null,
      number: null,
      inactive: false,
    };
  }

  if (!info.student) throw DataGsmErrors.unavailable('MISSING_STUDENT_PROFILE');
  const student = toStudent(info.student);
  return {
    ...base,
    datagsmStudentId: student.studentId,
    role: 'STUDENT',
    name: student.name,
    studentNumber: student.studentNumber,
    grade: student.grade,
    classNo: student.classNo,
    number: student.number,
    inactive: student.inactive,
  };
}

function toStudent(student: z.infer<typeof Student>): DataGsmStudent {
  return {
    studentId: student.id != null ? String(student.id) : null,
    email: student.email ?? null,
    name: student.name,
    studentNumber: student.studentNumber != null ? String(student.studentNumber) : null,
    grade: student.grade ?? null,
    classNo: student.classNum ?? null,
    number: student.number ?? null,
    inactive: INACTIVE_STUDENT_ROLES.has(student.role ?? ''),
  };
}
