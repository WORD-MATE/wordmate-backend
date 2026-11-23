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

export const UpdateProfile = z
  .object({
    avatarId: z
      .string()
      .max(32)
      .nullable()
      .optional()
      .describe('생략하면 그대로, null이면 기본 아바타(default)'),
    representativeBadgeId: z
      .uuid()
      .nullable()
      .optional()
      .describe('생략하면 그대로, null이면 해제. 가진 배지만 지정 가능'),
  })
  .meta({ id: 'UpdateProfile' });

export const AvatarList = z
  .array(
    z.object({
      avatarId: z.string(),
      imageUrl: z.string().describe('앱이 이미지 주소로 바꾸는 키'),
    }),
  )
  .meta({ id: 'AvatarList' });
