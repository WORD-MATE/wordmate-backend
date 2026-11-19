import { randomUUID } from 'node:crypto';
import { Controller, Get } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Database, DB } from '../src/infra/db/db.module.js';
import { policies, userAgreements } from '../src/infra/db/schema/index.js';
import { DataGsmClient, type DataGsmProfile } from '../src/modules/auth/datagsm/datagsm.client.js';
import { PoliciesService } from '../src/modules/policies/policies.service.js';
import { createTestApp, inject } from './support/create-test-app.js';
import { TEST_REDIRECT_URI } from './support/test-env.js';

@Controller('test-terms')
class ProtectedController {
  @Get()
  protectedRoute() {
    return { ok: true };
  }
}

const DAY = 86_400_000;
const policy = (
  type: 'TERMS' | 'PRIVACY' | 'MARKETING',
  version: string,
  options: { required?: boolean; requireReagreement?: boolean; effectiveAt?: Date } = {},
) => ({
  type,
  version,
  title: `${type} ${version}`,
  content: `# ${type} ${version}`,
  required: options.required ?? type !== 'MARKETING',
  requireReagreement: options.requireReagreement ?? false,
  effectiveAt: options.effectiveAt ?? new Date(Date.now() - DAY),
});

describe('약관 동의·nextStep·내 정보', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let token: string;

  const profile: DataGsmProfile = {
    datagsmId: randomUUID(),
    email: null,
    role: 'STUDENT',
    name: '약관학생',
    studentNumber: '1101',
    grade: 1,
    classNo: 1,
    number: 1,
    inactive: false,
    pending: false,
  };

  const authed = (url: string, method: 'GET' | 'POST' = 'GET', payload?: Record<string, unknown>) =>
    inject(app, { method, url, payload, headers: { authorization: `Bearer ${token}` } });

  const agree = (items: Array<{ type: string; version: string; agreed: boolean }>) =>
    authed('/users/me/agreements', 'POST', { items });

  const addPolicy = async (row: ReturnType<typeof policy>) => {
    await db.insert(policies).values(row);
    app.get(PoliciesService).clearCache();
  };

  beforeAll(async () => {
    app = await createTestApp({
      controllers: [ProtectedController],
      overrides: [
        [DataGsmClient, { exchangeCode: async () => 'at', getProfile: async () => profile }],
      ],
    });
    db = app.get(DB);
    await db
      .insert(policies)
      .values([
        policy('TERMS', '1.0'),
        policy('PRIVACY', '1.0'),
        policy('MARKETING', '1.0'),
        policy('TERMS', '9.0', { effectiveAt: new Date(Date.now() + DAY) }),
      ]);
  });

  afterAll(async () => {
    await db.delete(userAgreements);
    await db.delete(policies);
    await app.close();
  });

  it('필수 약관에 동의하지 않았으면 로그인 nextStep이 TERMS_AGREEMENT', async () => {
    const res = await inject(app, {
      method: 'POST',
      url: '/auth/datagsm',
      payload: { code: 'c', codeVerifier: 'v'.repeat(43), redirectUri: TEST_REDIRECT_URI },
    });
    expect(res.json().nextStep).toBe('TERMS_AGREEMENT');
    token = res.json().accessToken;
  });

  it('동의 전에는 일반 API가 403 TERMS_AGREEMENT_REQUIRED, 내 정보·동의 현황은 호출 가능', async () => {
    const blocked = await authed('/test-terms');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('TERMS_AGREEMENT_REQUIRED');

    const me = await authed('/users/me');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ name: '약관학생', role: 'STUDENT', grade: 1 });

    const status = await authed('/users/me/agreements');
    expect(status.json()).toEqual({
      needsAgreement: true,
      policies: expect.arrayContaining([
        {
          type: 'TERMS',
          version: '1.0',
          title: 'TERMS 1.0',
          required: true,
          agreed: false,
          agreedAt: null,
        },
        expect.objectContaining({ type: 'MARKETING', required: false }),
      ]),
    });
    expect(status.json().policies).toHaveLength(3);
  });

  it('약관 전문은 시행 중인 버전만 보여준다', async () => {
    const res = await inject(app, { url: '/policies/TERMS' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      version: '1.0',
      content: '# TERMS 1.0',
      history: [{ version: '1.0' }],
    });
    expect((await inject(app, { url: '/policies/TERMS?version=9.0' })).statusCode).toBe(404);
  });

  it('필수 약관이 빠지면 400 AGREEMENT_REQUIRED_MISSING, 버전이 다르면 AGREEMENT_VERSION_OUTDATED', async () => {
    const missing = await agree([{ type: 'TERMS', version: '1.0', agreed: true }]);
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({
      code: 'AGREEMENT_REQUIRED_MISSING',
      detail: { types: ['PRIVACY'] },
    });

    const outdated = await agree([
      { type: 'TERMS', version: '0.9', agreed: true },
      { type: 'PRIVACY', version: '1.0', agreed: true },
    ]);
    expect(outdated.statusCode).toBe(400);
    expect(outdated.json()).toMatchObject({
      code: 'AGREEMENT_VERSION_OUTDATED',
      detail: { type: 'TERMS', currentVersion: '1.0' },
    });
  });

  it('필수 약관에 동의하면 nextStep HOME, 이후 일반 API 호출 가능', async () => {
    const res = await agree([
      { type: 'TERMS', version: '1.0', agreed: true },
      { type: 'PRIVACY', version: '1.0', agreed: true },
      { type: 'MARKETING', version: '1.0', agreed: false },
    ]);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ nextStep: 'HOME' });
    expect((await authed('/test-terms')).statusCode).toBe(200);

    const status = (await authed('/users/me/agreements')).json();
    expect(status.needsAgreement).toBe(false);
    expect(status.policies.find((p: { type: string }) => p.type === 'TERMS')).toMatchObject({
      agreed: true,
      agreedAt: expect.any(String),
    });
  });

  it('재동의가 필요 없는 개정은 계속 이용 가능, 재동의가 필요한 개정은 다시 막힌다', async () => {
    await addPolicy(policy('TERMS', '1.1'));
    expect((await authed('/test-terms')).statusCode).toBe(200);
    const minor = (await authed('/users/me/agreements')).json();
    expect(minor.needsAgreement).toBe(false);
    expect(minor.policies.find((p: { type: string }) => p.type === 'TERMS').agreed).toBe(false);

    await addPolicy(policy('TERMS', '2.0', { requireReagreement: true }));
    expect((await authed('/test-terms')).statusCode).toBe(403);

    await agree([{ type: 'TERMS', version: '2.0', agreed: true }]);
    expect((await authed('/test-terms')).statusCode).toBe(200);
  });
});
