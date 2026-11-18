import { z } from 'zod';
import { NEXT_STEP } from '../../common/enums.js';
import { Me } from '../users/me.schema.js';

export const DataGsmLoginRequest = z.object({
  code: z.string().min(1).max(2048),
  codeVerifier: z.string().min(43).max(128),
  redirectUri: z.url(),
});

export const RefreshTokenBody = z
  .object({ refreshToken: z.string().min(1).nullish() })
  .nullish()
  .transform((body) => body?.refreshToken ?? null);

export const TokenResponse = z
  .object({
    accessToken: z.string().nullable(),
    refreshToken: z.string().nullable(),
    expiresIn: z.number().int(),
  })
  .meta({ id: 'TokenResponse' });

export const LoginResponse = TokenResponse.extend({
  nextStep: z.enum(NEXT_STEP),
  user: Me,
}).meta({ id: 'LoginResponse' });
