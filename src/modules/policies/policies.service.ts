import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, lte } from 'drizzle-orm';
import { POLICY_TYPE, type PolicyType } from '../../common/enums.js';
import { AppException } from '../../common/errors/app-exception.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { type Policy, policies } from '../../infra/db/schema/index.js';

const CACHE_TTL_MS = 60_000;

export interface PolicyState {
  current: Policy;
  /** 이 버전 이상에 동의했으면 다시 동의할 필요가 없다 */
  baseline: Policy;
  effectiveAtByVersion: Map<string, Date>;
}

export const PolicyErrors = {
  notFound: () =>
    new AppException('POLICY_NOT_FOUND', '약관을 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
};

@Injectable()
export class PoliciesService {
  private cache: { states: Map<PolicyType, PolicyState>; expiresAt: number } | null = null;

  constructor(@Inject(DB) private readonly db: Database) {}

  async currentStates(): Promise<Map<PolicyType, PolicyState>> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.states;

    const rows = await this.db
      .select()
      .from(policies)
      .where(lte(policies.effectiveAt, new Date()))
      .orderBy(asc(policies.effectiveAt));

    const states = new Map<PolicyType, PolicyState>();
    for (const type of POLICY_TYPE) {
      const versions = rows.filter((row) => row.type === type);
      const current = versions.at(-1);
      const first = versions[0];
      if (!current || !first) continue;
      states.set(type, {
        current,
        baseline: versions.findLast((row) => row.requireReagreement) ?? first,
        effectiveAtByVersion: new Map(versions.map((row) => [row.version, row.effectiveAt])),
      });
    }

    this.cache = { states, expiresAt: Date.now() + CACHE_TTL_MS };
    return states;
  }

  async find(type: PolicyType, version?: string) {
    const versions = await this.db
      .select()
      .from(policies)
      .where(and(eq(policies.type, type), lte(policies.effectiveAt, new Date())))
      .orderBy(asc(policies.effectiveAt));

    const policy = version ? versions.find((row) => row.version === version) : versions.at(-1);
    if (!policy) throw PolicyErrors.notFound();

    return {
      type: policy.type,
      version: policy.version,
      title: policy.title,
      effectiveAt: policy.effectiveAt.toISOString(),
      content: policy.content,
      history: versions
        .map((row) => ({ version: row.version, effectiveAt: row.effectiveAt.toISOString() }))
        .reverse(),
    };
  }

  clearCache(): void {
    this.cache = null;
  }
}
