import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { PolicyType } from '../../common/enums.js';
import { AppException } from '../../common/errors/app-exception.js';
import { withTimeout } from '../../common/with-timeout.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { type UserAgreement, userAgreements } from '../../infra/db/schema/index.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { PoliciesService, type PolicyState } from '../policies/policies.service.js';

const CACHE_TTL_SECONDS = 600;
const CACHE_TIMEOUT_MS = 300;

export interface AgreementItem {
  type: PolicyType;
  version: string;
  agreed: boolean;
}

export const AgreementErrors = {
  requiredMissing: (types: PolicyType[]) =>
    new AppException(
      'AGREEMENT_REQUIRED_MISSING',
      '필수 약관에 동의해야 합니다.',
      HttpStatus.BAD_REQUEST,
      { types },
    ),
  versionOutdated: (type: PolicyType, currentVersion: string | null) =>
    new AppException(
      'AGREEMENT_VERSION_OUTDATED',
      '최신 약관이 아닙니다. 약관을 다시 확인해 주세요.',
      HttpStatus.BAD_REQUEST,
      { type, currentVersion },
    ),
};

const isSatisfied = (state: PolicyState, latest: UserAgreement | undefined) => {
  if (!latest?.agreed) return false;
  const agreedEffectiveAt = state.effectiveAtByVersion.get(latest.version);
  return agreedEffectiveAt !== undefined && agreedEffectiveAt >= state.baseline.effectiveAt;
};

@Injectable()
export class AgreementService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly policies: PoliciesService,
  ) {}

  async status(userId: string) {
    const [states, latest] = await Promise.all([
      this.policies.currentStates(),
      this.latestByType(userId),
    ]);

    const items = [...states.entries()].map(([type, state]) => {
      const agreement = latest.get(type);
      const agreedCurrent =
        agreement?.agreed === true && agreement.version === state.current.version;
      return {
        type,
        version: state.current.version,
        title: state.current.title,
        required: state.current.required,
        agreed: agreedCurrent,
        agreedAt: agreedCurrent ? agreement.agreedAt.toISOString() : null,
        satisfied: isSatisfied(state, agreement),
      };
    });

    return {
      policies: items.map(({ satisfied: _, ...item }) => item),
      needsAgreement: items.some((item) => item.required && !item.satisfied),
    };
  }

  /** 마케팅 정보 수신: 가장 최근 마케팅 약관 응답이 동의인지 (버전과 상관없이 철회 전까지 유효) */
  async marketingAgreed(userId: string): Promise<boolean> {
    return (await this.marketingAgreedAmong([userId])).has(userId);
  }

  /** 여러 사용자 가운데 마케팅 정보 수신에 동의한 사용자 (한 번의 조회) */
  async marketingAgreedAmong(userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.db
      .select({ userId: userAgreements.userId, agreed: userAgreements.agreed })
      .from(userAgreements)
      .where(
        and(inArray(userAgreements.userId, userIds), eq(userAgreements.policyType, 'MARKETING')),
      )
      .orderBy(desc(userAgreements.id));
    const latest = new Map<string, boolean>();
    for (const row of rows) if (!latest.has(row.userId)) latest.set(row.userId, row.agreed);
    return new Set([...latest].filter(([, agreed]) => agreed).map(([userId]) => userId));
  }

  async needsAgreement(userId: string): Promise<boolean> {
    const key = this.cacheKey(userId, await this.policies.currentStates());
    const cached = await withTimeout(this.valkey.get(key), CACHE_TIMEOUT_MS).catch(() => null);
    if (cached !== null) return cached === '1';

    const { needsAgreement } = await this.status(userId);
    await withTimeout(
      this.valkey.set(key, needsAgreement ? '1' : '0', 'EX', CACHE_TTL_SECONDS),
      CACHE_TIMEOUT_MS,
    ).catch(() => {});
    return needsAgreement;
  }

  async submit(userId: string, items: AgreementItem[]): Promise<void> {
    const [states, latest] = await Promise.all([
      this.policies.currentStates(),
      this.latestByType(userId),
    ]);

    for (const item of items) {
      const state = states.get(item.type);
      if (!state || state.current.version !== item.version) {
        throw AgreementErrors.versionOutdated(item.type, state?.current.version ?? null);
      }
    }

    const submitted = new Map(items.map((item) => [item.type, item]));
    const missing = [...states.entries()]
      .filter(([type, state]) => {
        if (!state.current.required) return false;
        const item = submitted.get(type);
        return item ? !item.agreed : !isSatisfied(state, latest.get(type));
      })
      .map(([type]) => type);
    if (missing.length > 0) throw AgreementErrors.requiredMissing(missing);

    if (items.length > 0) {
      const now = new Date();
      await this.db.insert(userAgreements).values(
        items.map((item) => ({
          userId,
          policyType: item.type,
          version: item.version,
          agreed: item.agreed,
          agreedAt: now,
        })),
      );
    }
    await this.valkey.del(this.cacheKey(userId, states)).catch(() => {});
  }

  private async latestByType(userId: string): Promise<Map<PolicyType, UserAgreement>> {
    const rows = await this.db
      .select()
      .from(userAgreements)
      .where(eq(userAgreements.userId, userId))
      .orderBy(desc(userAgreements.id));
    const latest = new Map<PolicyType, UserAgreement>();
    for (const row of rows) {
      if (!latest.has(row.policyType)) latest.set(row.policyType, row);
    }
    return latest;
  }

  private cacheKey(userId: string, states: Map<PolicyType, PolicyState>): string {
    const revision = [...states.values()].map((state) => state.baseline.id).join(',');
    return `terms:needs:${userId}:${revision}`;
  }
}
