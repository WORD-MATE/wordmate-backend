import { and, asc, eq } from 'drizzle-orm';
import type { Database, Transaction } from '../../infra/db/db.module.js';
import { battleRoomParticipants } from '../../infra/db/schema/index.js';

/** 방에 남아 있는 참가자 (먼저 들어온 순) */
export function activeParticipants(executor: Database | Transaction, roomId: string) {
  return executor
    .select({ userId: battleRoomParticipants.userId, state: battleRoomParticipants.state })
    .from(battleRoomParticipants)
    .where(and(eq(battleRoomParticipants.roomId, roomId), eq(battleRoomParticipants.active, true)))
    .orderBy(asc(battleRoomParticipants.joinedAt));
}

/** 알림 받을 사람: 방에 남은 참가자 + 진행자(교사) */
export async function roomMembers(
  executor: Database | Transaction,
  room: { id: string; hostUserId: string | null },
): Promise<string[]> {
  const ids = new Set((await activeParticipants(executor, room.id)).map((row) => row.userId));
  if (room.hostUserId) ids.add(room.hostUserId);
  return [...ids];
}
