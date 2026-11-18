import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { z } from 'zod';
import type { Role } from '../../../common/enums.js';
import { AppException } from '../../../common/errors/app-exception.js';
import type { Env } from '../../../config/env.js';

const TIMEOUT_MS = 5000;

const TokenResponse = z.object({ access_token: z.string().min(1) });

const UserInfo = z.object({
  id: z.number().int(),
  email: z.string().nullish(),
  status: z.string().nullish(),
  objectType: z.enum(['STUDENT', 'TEACHER']),
  student: z
    .object({
      name: z.string(),
      grade: z.number().int().nullish(),
      classNum: z.number().int().nullish(),
      number: z.number().int().nullish(),
      studentNumber: z.number().int().nullish(),
      role: z.string().nullish(),
    })
    .nullish(),
  teacher: z.object({ name: z.string() }).nullish(),
});

export interface DataGsmProfile {
  datagsmId: string;
  email: string | null;
  role: Role;
  name: string;
  studentNumber: string | null;
  grade: number | null;
  classNo: number | null;
  number: number | null;
  /** 졸업·자퇴 */
  inactive: boolean;
  /** DataGSM 가입 승인 대기 */
  pending: boolean;
}

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
      role: 'TEACHER',
      name: info.teacher.name,
      studentNumber: null,
      grade: null,
      classNo: null,
      number: null,
      inactive: false,
    };
  }

  const { student } = info;
  if (!student) throw DataGsmErrors.unavailable('MISSING_STUDENT_PROFILE');
  return {
    ...base,
    role: 'STUDENT',
    name: student.name,
    studentNumber: student.studentNumber != null ? String(student.studentNumber) : null,
    grade: student.grade ?? null,
    classNo: student.classNum ?? null,
    number: student.number ?? null,
    inactive: INACTIVE_STUDENT_ROLES.has(student.role ?? ''),
  };
}
