import { and, eq, ne } from 'drizzle-orm';
import type { Database, Transaction } from '../../infra/db/db.module.js';
import { users } from '../../infra/db/schema/index.js';

/** 이 사용자 말고 활동 중인 관리자가 있는지 */
export async function hasOtherActiveAdmin(
  executor: Database | Transaction,
  userId: string,
): Promise<boolean> {
  const [other] = await executor
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.isAdmin, true), eq(users.status, 'ACTIVE'), ne(users.id, userId)))
    .limit(1);
  return other !== undefined;
}
