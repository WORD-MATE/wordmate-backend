import { and, eq, sql } from 'drizzle-orm';
import type { MissionMetric, MissionPeriod } from '../../common/enums.js';
import { kstDate, kstDayRange, kstWeekRange } from '../../common/time/kst.js';
import type { Transaction } from '../../infra/db/db.module.js';
import { missions, userMissions, users } from '../../infra/db/schema/index.js';

/** 일일은 그날, 주간은 그 주 월요일 (KST 자정 기준) */
export function periodKeyOf(period: MissionPeriod, now: Date): string {
  const today = Temporal.PlainDate.from(kstDate(now));
  return period === 'DAILY'
    ? today.toString()
    : today.subtract({ days: today.dayOfWeek - 1 }).toString();
}

export function expiresAtOf(period: MissionPeriod, now: Date): Date {
  const today = kstDate(now);
  return period === 'DAILY' ? kstDayRange(today).end : kstWeekRange(today).end;
}

/**
 * 활동이 생긴 트랜잭션 안에서 진행을 올린다(목표에서 멈춤).
 * 보상 수령과 같은 순서(사용자 행 → 진행 행)로 잠가 서로 기다리다 막히지 않게 한다
 */
export async function addMissionProgress(
  tx: Transaction,
  userId: string,
  metric: MissionMetric,
  amount: number,
  now: Date,
): Promise<void> {
  if (amount <= 0) return;
  const defs = await tx
    .select({ id: missions.id, period: missions.period, target: missions.target })
    .from(missions)
    .where(and(eq(missions.metric, metric), eq(missions.active, true)));
  if (defs.length === 0) return;
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
  for (const def of defs) {
    await tx
      .insert(userMissions)
      .values({
        userId,
        missionId: def.id,
        periodKey: periodKeyOf(def.period, now),
        progress: Math.min(amount, def.target),
      })
      .onDuplicateKeyUpdate({
        set: { progress: sql`LEAST(${userMissions.progress} + ${amount}, ${def.target})` },
      });
  }
}
