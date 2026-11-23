import { z } from 'zod';
import { POLICY_TYPE } from '../../common/enums.js';

export const CreatePolicy = z
  .object({
    type: z.enum(POLICY_TYPE),
    version: z.string().trim().min(1).max(20),
    title: z.string().trim().min(1).max(100),
    content: z.string().trim().min(1).max(200_000).describe('Markdown, 법무 검토 확정본'),
    effectiveAt: z.iso
      .datetime()
      .refine((value) => new Date(value).getTime() > Date.now(), '시행일은 지금 이후여야 합니다.'),
    requireReagreement: z
      .boolean()
      .default(false)
      .describe('수집 항목·목적이 바뀌면 true (시행 뒤 다음 요청부터 재동의 안내)'),
    required: z
      .boolean()
      .optional()
      .describe('필수 동의 여부. 없으면 같은 종류의 직전 버전을 따름'),
  })
  .meta({ id: 'CreatePolicy' });
export type CreatePolicy = z.infer<typeof CreatePolicy>;

export const PolicyCreated = z.object({ version: z.string() }).meta({ id: 'PolicyCreated' });

export const AdminPolicyQuery = z.object({ type: z.enum(POLICY_TYPE).optional() });

export const AdminPolicyList = z
  .array(
    z.object({
      type: z.enum(POLICY_TYPE),
      version: z.string(),
      title: z.string(),
      required: z.boolean(),
      requireReagreement: z.boolean(),
      effectiveAt: z.iso.datetime(),
      upcoming: z.boolean().describe('아직 시행 전'),
    }),
  )
  .meta({ id: 'AdminPolicyList' });
