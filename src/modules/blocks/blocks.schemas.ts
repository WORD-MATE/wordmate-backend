import { z } from 'zod';
import { UserSummary } from '../users/user-summary.js';

export const BlockedUser = z
  .object({ user: UserSummary, blockedAt: z.iso.datetime() })
  .meta({ id: 'BlockedUser' });
export const BlockedUserList = z.array(BlockedUser).meta({ id: 'BlockedUserList' });

export const BlockUser = z.object({ userId: z.uuid() }).meta({ id: 'BlockUser' });
export type BlockUser = z.infer<typeof BlockUser>;
