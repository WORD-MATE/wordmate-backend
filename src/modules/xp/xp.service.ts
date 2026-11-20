import { Injectable } from '@nestjs/common';
import { and, eq, sum } from 'drizzle-orm';
import type { XpBlockReason, XpSource } from '../../common/enums.js';
import { kstDate } from '../../common/time/kst.js';
import type { Transaction } from '../../infra/db/db.module.js';
import { users, xpLedger } from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';

/** 모든 출처를 합친 하루(KST) XP 상한 */
export const DAILY_XP_CAP = 500;

export type XpGrant = { source: XpSource; refKey: string; amount: number };

export type XpGrantResult = {
  /** 요청 순서대로 실제로 준 XP. 이미 받은 refKey면 null */
  granted: (number | null)[];
  earned: number;
  capped: boolean;
  todayTotal: number;
};

@Injectable()
export class XpService {
  /**
   * 트랜잭션 안에서 호출한다. 사용자 행을 잠가 동시에 지급해도 하루 상한을 넘지 않게 하고,
   * (출처, refKey)가 이미 원장에 있으면 다시 주지 않는다. 상한에 걸려 0이 된 지급도 원장에 남긴다
   */
  async grant(
    tx: Transaction,
    userId: string,
    grants: XpGrant[],
    now = new Date(),
  ): Promise<XpGrantResult> {
    const date = kstDate(now);
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    const [row] = await tx
      .select({ total: sum(xpLedger.amount) })
      .from(xpLedger)
      .where(and(eq(xpLedger.userId, userId), eq(xpLedger.date, date)));
    let todayTotal = Number(row?.total ?? 0);

    const granted: (number | null)[] = [];
    let capped = false;
    for (const grant of grants) {
      const amount = Math.max(0, Math.min(grant.amount, DAILY_XP_CAP - todayTotal));
      const blockedReason: XpBlockReason | null = amount < grant.amount ? 'DAILY_CAP' : null;
      const [result] = await tx.insert(xpLedger).ignore().values({
        id: newId(),
        userId,
        source: grant.source,
        refKey: grant.refKey,
        amount,
        blockedReason,
        date,
      });
      if (result.affectedRows === 0) {
        granted.push(null);
        continue;
      }
      if (blockedReason) capped = true;
      todayTotal += amount;
      granted.push(amount);
    }
    return {
      granted,
      earned: granted.reduce<number>((total, amount) => total + (amount ?? 0), 0),
      capped,
      todayTotal,
    };
  }
}
