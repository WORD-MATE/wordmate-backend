import { Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { type Database, DB } from '../../infra/db/db.module.js';
import { auditLogs } from '../../infra/db/schema/index.js';
import type { AuditAction } from '../enums.js';

export interface AuditEntry {
  actorId: string | null;
  action: AuditAction;
  targetType: string;
  targetId: string | null;
  detail: Record<string, unknown>;
}

type Executor = Pick<Database, 'insert'>;

@Injectable()
export class AuditLogService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async record(entry: AuditEntry, request?: FastifyRequest, executor: Executor = this.db) {
    const userAgent = request?.headers['user-agent'];
    await executor.insert(auditLogs).values({
      ...entry,
      ip: request?.ip ?? null,
      userAgent: userAgent ? userAgent.slice(0, 255) : null,
    });
  }
}
