import { and, inArray, like, lte, or } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { AccessTokenService } from '../common/auth/access-token.service.js';
import type { Database } from '../infra/db/db.module.js';
import {
  battleAnswers,
  battleDailyPairs,
  battleResults,
  battleRoomParticipants,
  battleRooms,
  challengeAttempts,
  packs,
  policies,
  practiceSessions,
  studySessions,
  userAgreements,
  users,
  words,
} from '../infra/db/schema/index.js';
import { newId } from '../infra/db/uuid.js';

/** 부하 테스트 계정 표시. datagsm_id가 이것으로 시작하는 계정만 만들고 지운다 */
export const LOAD_USER_MARK = 'loadtest:';
export const MAX_LOAD_USERS = 500;

export type LoadToken = { userId: string; token: string };

const loadUserIds = async (db: Database) =>
  (
    await db
      .select({ id: users.id })
      .from(users)
      .where(like(users.datagsmId, `${LOAD_USER_MARK}%`))
  ).map((row) => row.id);

/**
 * 학생 계정을 count개까지 만들고(이미 있으면 그대로) 지금 시행 중인 약관에 모두 동의시킨다.
 * 학년·반을 돌려 가며 나눠 랭킹 범위가 한쪽에 몰리지 않게 하고, 랭킹 목록에는 나오지 않게 비공개로 둔다
 */
export async function createLoadUsers(
  db: Database,
  count: number,
): Promise<{ users: number; policies: number }> {
  await db
    .insert(users)
    .ignore()
    .values(
      Array.from({ length: count }, (_, i) => ({
        id: newId(),
        datagsmId: `${LOAD_USER_MARK}${String(i + 1).padStart(3, '0')}`,
        name: `부하테스트${i + 1}`,
        role: 'STUDENT' as const,
        grade: (i % 3) + 1,
        classNo: (Math.floor(i / 3) % 4) + 1,
        rankingPublic: false,
        rankingOnboarded: true,
      })),
    );
  const ids = await loadUserIds(db);
  const effective = await db
    .select({ type: policies.type, version: policies.version })
    .from(policies)
    .where(lte(policies.effectiveAt, new Date()));
  await db.delete(userAgreements).where(inArray(userAgreements.userId, ids));
  const agreedAt = new Date();
  const rows = ids.flatMap((userId) =>
    effective.map((policy) => ({
      id: newId(),
      userId,
      policyType: policy.type,
      version: policy.version,
      agreed: true,
      agreedAt,
    })),
  );
  if (rows.length > 0) await db.insert(userAgreements).values(rows);
  return { users: ids.length, policies: effective.length };
}

/** 계정마다 액세스 토큰 (30분 유효, 기기는 매번 새로) */
export async function issueLoadTokens(
  db: Database,
  signer: AccessTokenService,
): Promise<LoadToken[]> {
  const ids = await loadUserIds(db);
  return Promise.all(
    ids.map(async (userId) => ({
      userId,
      token: await signer.sign({ userId, role: 'STUDENT', isAdmin: false, deviceId: newId() }),
    })),
  );
}

/**
 * 계정과 그 흔적을 지운다. 이 계정들이 연 방(대결·문항·답·결과는 함께 지워짐)부터,
 * 다른 방에 남은 기록, 계정 순서로 지우고 랭킹·매칭 대기열에서도 뺀다. XP 원장·오답노트·약관 동의는 계정과 함께 지워진다
 */
export async function cleanupLoadUsers(db: Database, valkey: Redis): Promise<number> {
  const ids = await loadUserIds(db);
  if (ids.length === 0) return 0;
  await db.delete(battleRooms).where(inArray(battleRooms.hostUserId, ids));
  await db.delete(battleResults).where(inArray(battleResults.userId, ids));
  await db.delete(battleAnswers).where(inArray(battleAnswers.userId, ids));
  await db.delete(battleRoomParticipants).where(inArray(battleRoomParticipants.userId, ids));
  await db
    .delete(battleDailyPairs)
    .where(or(inArray(battleDailyPairs.userId, ids), inArray(battleDailyPairs.opponentId, ids)));
  await db.delete(challengeAttempts).where(inArray(challengeAttempts.userId, ids));
  await db.delete(practiceSessions).where(inArray(practiceSessions.userId, ids));
  await db.delete(studySessions).where(inArray(studySessions.userId, ids));
  const owned = (
    await db.select({ id: packs.id }).from(packs).where(inArray(packs.ownerUserId, ids))
  ).map((row) => row.id);
  if (owned.length > 0) {
    await db.delete(words).where(inArray(words.packId, owned));
    await db.delete(packs).where(inArray(packs.id, owned));
  }
  await db
    .delete(users)
    .where(and(inArray(users.id, ids), like(users.datagsmId, `${LOAD_USER_MARK}%`)));

  let cursor = '0';
  do {
    // rank: 아래에는 랭킹 외의 키(해시·문자열)도 있으므로 ZSET만 고른다
    const [next, keys] = await valkey.scan(cursor, 'MATCH', 'rank:*', 'COUNT', 200, 'TYPE', 'zset');
    for (const key of keys) await valkey.zrem(key, ...ids);
    cursor = next;
  } while (cursor !== '0');
  await valkey.zrem('mm:queue', ...ids);
  await valkey.hdel('mm:queued', ...ids);
  return ids.length;
}
