import { z } from 'zod';
import { NEXT_STEP, POLICY_TYPE } from '../../common/enums.js';

export const AgreementStatus = z
  .object({
    policies: z.array(
      z.object({
        type: z.enum(POLICY_TYPE),
        version: z.string(),
        title: z.string(),
        required: z.boolean(),
        agreed: z.boolean(),
        agreedAt: z.iso.datetime().nullable(),
      }),
    ),
    needsAgreement: z.boolean(),
  })
  .meta({ id: 'AgreementStatus' });

export const SubmitAgreements = z.object({
  items: z
    .array(
      z.object({
        type: z.enum(POLICY_TYPE),
        version: z.string().min(1).max(20),
        agreed: z.boolean(),
      }),
    )
    .min(1)
    .refine((items) => new Set(items.map((item) => item.type)).size === items.length, {
      message: '같은 약관을 두 번 보낼 수 없습니다.',
    }),
});

export const NextStepResponse = z.object({ nextStep: z.enum(NEXT_STEP) }).meta({
  id: 'NextStepResponse',
});

export const UpdatePrivacy = z.object({ rankingPublic: z.boolean() }).meta({ id: 'UpdatePrivacy' });

export const PrivacySettings = z
  .object({ rankingPublic: z.boolean(), rankingOnboarded: z.boolean() })
  .meta({ id: 'PrivacySettings' });
export type PrivacySettings = z.infer<typeof PrivacySettings>;
