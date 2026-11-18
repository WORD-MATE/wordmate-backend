import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppException } from '../../../common/errors/app-exception.js';
import type { Env } from '../../../config/env.js';
import { DataGsmClient } from './datagsm.client.js';

const config = {
  get: (key: string) =>
    ({
      DATAGSM_AUTH_URL: 'https://auth.test',
      DATAGSM_RESOURCE_URL: 'https://resource.test',
      DATAGSM_CLIENT_ID: 'client-1',
    })[key],
} as unknown as ConfigService<Env, true>;

const client = new DataGsmClient(config);

const mockFetch = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

const student = {
  id: 42,
  email: 's@gsm.hs.kr',
  status: 'ACTIVE',
  objectType: 'STUDENT',
  student: {
    name: '김학생',
    grade: 2,
    classNum: 3,
    number: 7,
    studentNumber: 2307,
    role: 'GENERAL_STUDENT',
  },
  teacher: null,
};

const errorCode = async (promise: Promise<unknown>) => {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AppException);
  return [(error as AppException).getStatus(), (error as AppException).code];
};

describe('DataGsmClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('인가 코드를 PKCE로 교환한다 (client_secret 없이)', async () => {
    const fetch = mockFetch(200, { access_token: 'at', token_type: 'Bearer' });
    vi.stubGlobal('fetch', fetch);

    await expect(
      client.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'wordmate://cb' }),
    ).resolves.toBe('at');

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://auth.test/v1/oauth/token');
    expect(JSON.parse(String(init.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'c',
      code_verifier: 'v',
      redirect_uri: 'wordmate://cb',
      client_id: 'client-1',
    });
  });

  it('토큰 교환 4xx는 401 AUTH_DATAGSM_FAILED, 5xx는 502 DATAGSM_UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', mockFetch(400, { error: 'invalid_grant' }));
    expect(
      await errorCode(client.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'x' })),
    ).toEqual([401, 'AUTH_DATAGSM_FAILED']);

    vi.stubGlobal('fetch', mockFetch(503, {}));
    expect(
      await errorCode(client.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'x' })),
    ).toEqual([502, 'DATAGSM_UNAVAILABLE']);
  });

  it('네트워크 오류는 502 DATAGSM_UNAVAILABLE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    expect(await errorCode(client.getProfile('at'))).toEqual([502, 'DATAGSM_UNAVAILABLE']);
  });

  it('학생 정보를 계정 프로필로 바꾼다', async () => {
    const fetch = mockFetch(200, student);
    vi.stubGlobal('fetch', fetch);

    expect(await client.getProfile('at')).toEqual({
      datagsmId: '42',
      email: 's@gsm.hs.kr',
      role: 'STUDENT',
      name: '김학생',
      studentNumber: '2307',
      grade: 2,
      classNo: 3,
      number: 7,
      inactive: false,
      pending: false,
    });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://resource.test/userinfo');
    expect(init.headers).toEqual({ Authorization: 'Bearer at' });
  });

  it('졸업생·자퇴생은 inactive', async () => {
    for (const role of ['GRADUATE', 'WITHDRAWN']) {
      vi.stubGlobal('fetch', mockFetch(200, { ...student, student: { ...student.student, role } }));
      expect((await client.getProfile('at')).inactive).toBe(true);
    }
  });

  it('교사는 학적 정보 없이 이름만 쓴다', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch(200, {
        id: 7,
        email: 't@gsm.hs.kr',
        objectType: 'TEACHER',
        student: null,
        teacher: { name: '박선생' },
      }),
    );
    expect(await client.getProfile('at')).toMatchObject({
      role: 'TEACHER',
      name: '박선생',
      grade: null,
      studentNumber: null,
    });
  });

  it('student_read 권한이 없어 학생 정보가 비어 있으면 502', async () => {
    vi.stubGlobal('fetch', mockFetch(200, { ...student, student: null }));
    expect(await errorCode(client.getProfile('at'))).toEqual([502, 'DATAGSM_UNAVAILABLE']);
  });
});
