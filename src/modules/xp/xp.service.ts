import { Injectable } from '@nestjs/common';
import { and, eq, ne, sql, sum } from 'drizzle-orm';
import type { XpBlockReason, XpSource } from '../../common/enums.js';
import { kstDate } from '../../common/time/kst.js';
import type { Transaction } from '../../infra/db/db.module.js';
import { users, xpLedger } from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { addMissionProgress } from '../missions/mission-progress.js';

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
   * 트랜잭션 안에서 호출하고, 커밋된 뒤 RankingService.addXp로 랭킹에 반영한다.
   * 사용자 행을 잠가 동시에 지급해도 하루 상한을 넘지 않게 하고,
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
    // 잠금 읽기로 합계를 구한다. 일반 읽기는 트랜잭션의 첫 일반 읽기 때 잡힌 스냅숏을 봐서,
    // 그 뒤 다른 곳에서 커밋한 지급이 빠져 하루 상한을 넘을 수 있다
    const [row] = await tx
      .select({ total: sum(xpLedger.amount) })
      .from(xpLedger)
      .where(
        and(
          eq(xpLedger.userId, userId),
          eq(xpLedger.date, date),
          // 관리자 조정은 상한에 넣지 않는다 (사용자가 그날 받을 XP를 막지 않게)
          ne(xpLedger.source, 'ADMIN_ADJUST'),
        ),
      )
      .for('share');
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
    const earned = granted.reduce<number>((total, amount) => total + (amount ?? 0), 0);
    // 미션 보상이 다시 XP 미션을 채우지 않게 뺀다
    const missionCounted = grants.reduce(
      (total, grant, i) => total + (grant.source === 'MISSION' ? 0 : (granted[i] ?? 0)),
      0,
    );
    await addMissionProgress(tx, userId, 'XP_EARNED', missionCounted, now);
    if (earned > 0) {
      await tx
        .update(users)
        .set({ totalXp: sql`${users.totalXp} + ${earned}` })
        .where(eq(users.id, userId));
    }
    return {
      granted,
      earned,
      capped,
      todayTotal,
    };
  }

  /**
   * 관리자 조정(제재 XP 회수 포함). 하루 상한을 적용하지 않고 상한 계산에도 넣지 않는다 (출처 ADMIN_ADJUST).
   * 호출하는 쪽이 사용자 행을 잠그고 0 아래로 내려가지 않는지 확인한 뒤 같은 트랜잭션에서 부른다
   */
  async adjust(
    tx: Transaction,
    userId: string,
    amount: number,
    { refKey, now = new Date() }: { refKey?: string; now?: Date } = {},
  ): Promise<void> {
    await tx
      .update(users)
      .set({ totalXp: sql`${users.totalXp} + ${amount}` })
      .where(eq(users.id, userId));
    const id = newId();
    await tx.insert(xpLedger).values({
      id,
      userId,
      source: 'ADMIN_ADJUST',
      refKey: refKey ?? id,
      amount,
      date: kstDate(now),
    });
  }
}
