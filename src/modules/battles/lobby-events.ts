import { and, eq } from 'drizzle-orm';
import { type BattleRoom, battleRoomParticipants } from '../../infra/db/schema/index.js';
import { RealtimeService } from '../realtime/realtime.service.js';

export type LobbyEvent = { userIds: string[]; type: string; payload: unknown };

export const participantIs = (roomId: string, userId: string) =>
  and(eq(battleRoomParticipants.roomId, roomId), eq(battleRoomParticipants.userId, userId));

export const toOthers = (
  room: BattleRoom,
  members: string[],
  userId: string,
  state: string,
): LobbyEvent => ({
  userIds: members.filter((id) => id !== userId),
  type: 'PARTICIPANT_STATE',
  payload: { roomId: room.id, userId, state },
});

export const publishEvents = async (realtime: RealtimeService, events: LobbyEvent[]) => {
  for (const event of events) {
    await realtime.sendToUsers(event.userIds, event.type, event.payload).catch(() => {});
  }
};
