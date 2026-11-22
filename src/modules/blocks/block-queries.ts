import { and, eq, inArray, or } from 'drizzle-orm';
import type { Database, Transaction } from '../../infra/db/db.module.js';
import { blocks } from '../../infra/db/schema/index.js';

type Executor = Database | Transaction;

/** 어느 쪽이든 차단 관계가 있는가 */
export async function isBlockedBetween(db: Executor, a: string, b: string): Promise<boolean> {
  const [row] = await db
    .select({ blockerId: blocks.blockerId })
    .from(blocks)
    .where(
      or(
        and(eq(blocks.blockerId, a), eq(blocks.blockedId, b)),
        and(eq(blocks.blockerId, b), eq(blocks.blockedId, a)),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** 내가 차단했거나 나를 차단한 사용자 */
export async function blockedEitherWay(db: Executor, userId: string): Promise<string[]> {
  const rows = await db
    .select({ blockerId: blocks.blockerId, blockedId: blocks.blockedId })
    .from(blocks)
    .where(or(eq(blocks.blockerId, userId), eq(blocks.blockedId, userId)));
  return [...new Set(rows.map((r) => (r.blockerId === userId ? r.blockedId : r.blockerId)))];
}

/** candidates 가운데 userId를 차단한 사용자 */
export async function blockersAmong(
  db: Executor,
  userId: string,
  candidates: string[],
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const rows = await db
    .select({ blockerId: blocks.blockerId })
    .from(blocks)
    .where(and(eq(blocks.blockedId, userId), inArray(blocks.blockerId, candidates)));
  return new Set(rows.map((r) => r.blockerId));
}
