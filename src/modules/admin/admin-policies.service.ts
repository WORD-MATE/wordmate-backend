import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, lt } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { AuditLogService } from '../../common/audit/audit-log.service.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import type { PolicyType } from '../../common/enums.js';
import { AppException } from '../../common/errors/app-exception.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import { policies } from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { PoliciesService } from '../policies/policies.service.js';
import type { CreatePolicy } from './admin-policies.schemas.js';

export const AdminPolicyErrors = {
  sameEffectiveAt: () =>
    new AppException(
      'POLICY_EFFECTIVE_AT_EXISTS',
      '같은 종류에 같은 시행일의 버전이 이미 있습니다.',
      HttpStatus.CONFLICT,
    ),
  versionExists: () =>
    new AppException(
      'POLICY_VERSION_EXISTS',
      '같은 종류에 같은 버전이 이미 있습니다.',
      HttpStatus.CONFLICT,
    ),
};

@Injectable()
export class AdminPoliciesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditLogService,
    private readonly policies: PoliciesService,
  ) {}

  /** 시행 전 버전까지 모두, 종류별 시행일 순 */
  async list(type?: PolicyType) {
    const now = Date.now();
    const rows = await this.db
      .select()
      .from(policies)
      .where(type ? eq(policies.type, type) : undefined)
      .orderBy(asc(policies.type), asc(policies.effectiveAt));
    return rows.map((row) => ({
      type: row.type,
      version: row.version,
      title: row.title,
      required: row.required,
      requireReagreement: row.requireReagreement,
      effectiveAt: row.effectiveAt.toISOString(),
      upcoming: row.effectiveAt.getTime() > now,
    }));
  }

  /** 시행일이 되면 현재 약관이 된다(서버마다 약관 캐시 1분). 고지 공지는 따로 등록한다 */
  async create(
    admin: AuthUser,
    body: CreatePolicy,
    request: FastifyRequest,
  ): Promise<{ version: string }> {
    const effectiveAt = new Date(body.effectiveAt);
    // 시행일이 같으면 어느 쪽이 현재 약관인지 정해지지 않는다
    const [clash] = await this.db
      .select({ id: policies.id })
      .from(policies)
      .where(and(eq(policies.type, body.type), eq(policies.effectiveAt, effectiveAt)));
    if (clash) throw AdminPolicyErrors.sameEffectiveAt();
    // 새 버전 바로 앞 버전을 따른다 (나중에 시행될 버전이 아니라)
    const [previous] = await this.db
      .select({ required: policies.required })
      .from(policies)
      .where(and(eq(policies.type, body.type), lt(policies.effectiveAt, effectiveAt)))
      .orderBy(desc(policies.effectiveAt))
      .limit(1);
    const required = body.required ?? previous?.required ?? body.type !== 'MARKETING';
    const id = newId();
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(policies).values({
          id,
          type: body.type,
          version: body.version,
          title: body.title,
          content: body.content,
          required,
          requireReagreement: body.requireReagreement,
          effectiveAt,
        });
        await this.audit.record(
          {
            actorId: admin.userId,
            action: 'POLICY_CREATE',
            targetType: 'POLICY',
            targetId: id,
            detail: {
              type: body.type,
              version: body.version,
              effectiveAt: body.effectiveAt,
              required,
              requireReagreement: body.requireReagreement,
            },
          },
          request,
          tx,
        );
      });
    } catch (error) {
      if (isDuplicateKeyError(error, 'policies_type_version_uq')) {
        throw AdminPolicyErrors.versionExists();
      }
      throw error;
    }
    this.policies.clearCache();
    return { version: body.version };
  }
}
