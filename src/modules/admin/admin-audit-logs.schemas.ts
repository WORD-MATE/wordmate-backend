import { z } from 'zod';
import { AUDIT_ACTION } from '../../common/enums.js';
import { PageQuery, page } from '../../common/pagination.js';
import { UserSummary } from '../users/user-summary.js';

export const AuditLogQuery = PageQuery.extend({
  actorId: z.uuid().optional(),
  targetId: z.string().min(1).max(64).optional(),
  action: z.enum(AUDIT_ACTION).optional(),
  from: z.iso.date().optional().describe('KST 날짜, 포함'),
  to: z.iso.date().optional().describe('KST 날짜, 포함'),
}).refine((q) => !q.from || !q.to || q.from <= q.to, {
  message: '시작 날짜가 끝 날짜보다 늦습니다.',
  path: ['from'],
});
export type AuditLogQuery = z.infer<typeof AuditLogQuery>;

export const AuditLogItem = z
  .object({
    logId: z.string(),
    actor: UserSummary.nullable().describe('지워진 사용자면 null'),
    action: z.enum(AUDIT_ACTION),
    targetType: z.string(),
    targetId: z.string().nullable(),
    detail: z.record(z.string(), z.unknown()),
    ip: z.string().nullable(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'AuditLog' });
export type AuditLogItem = z.infer<typeof AuditLogItem>;

export const AuditLogPage = page(AuditLogItem).meta({ id: 'AuditLogPage' });
