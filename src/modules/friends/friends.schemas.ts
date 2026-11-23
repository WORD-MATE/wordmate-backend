import { z } from 'zod';
import { UserSummary } from '../users/user-summary.js';

export const FRIEND_REQUEST_DIRECTION = ['RECEIVED', 'SENT'] as const;

export const Friend = z
  .object({ user: UserSummary, since: z.iso.datetime() })
  .meta({ id: 'Friend' });
export const FriendList = z.array(Friend).meta({ id: 'FriendList' });

export const FriendRequestQuery = z.object({
  direction: z.enum(FRIEND_REQUEST_DIRECTION).default('RECEIVED'),
});
export type FriendRequestQuery = z.infer<typeof FriendRequestQuery>;

export const FriendRequest = z
  .object({
    requestId: z.string(),
    user: UserSummary.describe('받은 요청이면 보낸 사람, 보낸 요청이면 받는 사람'),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'FriendRequest' });
export const FriendRequestList = z.array(FriendRequest).meta({ id: 'FriendRequestList' });

export const SendFriendRequest = z.object({ userId: z.uuid() }).meta({ id: 'SendFriendRequest' });
export type SendFriendRequest = z.infer<typeof SendFriendRequest>;

export const FriendRequestCreated = z
  .object({
    requestId: z
      .string()
      .nullable()
      .describe('상대가 이미 나에게 요청을 보냈으면 바로 친구가 되어 null'),
  })
  .meta({ id: 'FriendRequestCreated' });
