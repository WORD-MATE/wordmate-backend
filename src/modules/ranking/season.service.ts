import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { SEASON_PERIOD } from '../../common/enums.js';
import { kstDate } from '../../common/time/kst.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import {
  type RankingSeason,
  rankingSeasons,
  rankingSnapshots,
  users,
} from '../../infra/db/schema/index.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { xpOfScore } from './ranking-keys.js';
import { listable } from './ranking-query.service.js';
import { endedSeasons, type SeasonRange, snapshotRanks } from './season.js';

const INSERT_CHUNK = 500;

export type CloseResult = { confirmed: string[]; failed: string[] };

@Injectable()
export class SeasonService {
  private readonly logger = new Logger(SeasonService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

  /**
   * 끝났는데 아직 확정하지 못한 시즌을 마감한다. 매시간 돌아서 실패(FAILED)나
   * 중간에 멈춘(CLOSED_PENDING) 시즌을 다시 시도하고, 서버가 꺼져 있던 동안 지난 시즌도 따라잡는다
   */
  async closeEnded(now = new Date()): Promise<CloseResult> {
    const result: CloseResult = { confirmed: [], failed: [] };
    const today = kstDate(now);
    for (const period of SEASON_PERIOD) {
      for (const [i, range] of endedSeasons(period, today).entries()) {
        const [season] = await this.db
          .select()
          .from(rankingSeasons)
          .where(
            and(eq(rankingSeasons.period, period), eq(rankingSeasons.periodKey, range.periodKey)),
          );
        if (season?.status === 'CONFIRMED') continue;
        // 막 끝난 시즌은 비어 있어도 남기고, 더 지난 기간은 기록이 있을 때만 만든다
        if (!season && i > 0 && !(await this.valkey.exists(this.schoolKey(range)))) continue;
        const label = `${period} ${range.periodKey}`;
        if (await this.close(range, season)) result.confirmed.push(label);
        else result.failed.push(label);
      }
    }
    return result;
  }

  private schoolKey(range: SeasonRange): string {
    return `rank:${range.period.toLowerCase()}:${range.periodKey}:school`;
  }

  private async close(range: SeasonRange, existing: RankingSeason | undefined): Promise<boolean> {
    const seasonId = existing?.id ?? (await this.open(range));
    try {
      const rows = await this.snapshotRows(range, seasonId);
      await this.db.transaction(async (tx) => {
        await tx.delete(rankingSnapshots).where(eq(rankingSnapshots.seasonId, seasonId));
        for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
          await tx.insert(rankingSnapshots).values(rows.slice(i, i + INSERT_CHUNK));
        }
        await tx
          .update(rankingSeasons)
          .set({
            status: 'CONFIRMED',
            confirmedAt: new Date(),
            lastError: null,
            attempts: (existing?.attempts ?? 0) + 1,
          })
          .where(eq(rankingSeasons.id, seasonId));
      });
      return true;
    } catch (error) {
      this.logger.error(`시즌 마감 실패 (${range.period} ${range.periodKey}): ${String(error)}`);
      await this.db
        .update(rankingSeasons)
        .set({
          status: 'FAILED',
          lastError: String(error).slice(0, 500),
          attempts: (existing?.attempts ?? 0) + 1,
        })
        .where(eq(rankingSeasons.id, seasonId));
      return false;
    }
  }

  /** 동시에 두 번 돌아도 시즌 행은 하나만 생기게 (period, period_key) 유니크에 기댄다 */
  private async open(range: SeasonRange): Promise<string> {
    await this.db
      .insert(rankingSeasons)
      .ignore()
      .values({ ...range, status: 'CLOSED_PENDING' });
    const [season] = await this.db
      .select({ id: rankingSeasons.id })
      .from(rankingSeasons)
      .where(
        and(eq(rankingSeasons.period, range.period), eq(rankingSeasons.periodKey, range.periodKey)),
      );
    return season?.id as string;
  }

  /** 그 기간의 학교·학년·반 ZSET을 모두 스냅샷으로. 교사·탈퇴로 지워진 사용자는 뺀다 */
  private async snapshotRows(range: SeasonRange, seasonId: string) {
    const prefix = `rank:${range.period.toLowerCase()}:${range.periodKey}:`;
    const rows: (typeof rankingSnapshots.$inferInsert)[] = [];
    for (const key of await this.scan(`${prefix}*`)) {
      const flat = await this.valkey.zrevrange(key, 0, -1, 'WITHSCORES');
      const members: { userId: string; xp: number }[] = [];
      for (let i = 0; i < flat.length; i += 2) {
        const xp = xpOfScore(Number(flat[i + 1]));
        if (xp > 0) members.push({ userId: flat[i] as string, xp });
      }
      if (members.length === 0) continue;
      const people = await this.db
        .select()
        .from(users)
        .where(
          inArray(
            users.id,
            members.map((m) => m.userId),
          ),
        );
      const byId = new Map(people.map((user) => [user.id, user]));
      const ranked = snapshotRanks(
        members.flatMap((member) => {
          const user = byId.get(member.userId);
          if (user?.role !== 'STUDENT') return [];
          return [{ ...member, listed: listable(user) }];
        }),
      );
      const scope = key.slice(prefix.length);
      for (const member of ranked) {
        rows.push({ seasonId, scope, ...member });
      }
    }
    return rows;
  }

  private async scan(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.valkey.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      keys.push(...batch);
      cursor = next;
    } while (cursor !== '0');
    return keys;
  }
}
