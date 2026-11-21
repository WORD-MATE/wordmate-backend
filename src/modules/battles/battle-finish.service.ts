import { Injectable } from '@nestjs/common';
import { and, asc, eq, gte, inArray, or, sql } from 'drizzle-orm';
import { kstDate } from '../../common/time/kst.js';
import type { Transaction } from '../../infra/db/db.module.js';
import {
  type Battle,
  type BattleRoom,
  battleAnswers,
  battleDailyPairs,
  battleQuestions,
  battleResults,
  battleRoomParticipants,
  users,
} from '../../infra/db/schema/index.js';
import { recordWrongWords } from '../wrong-notes/wrong-note-writer.js';
import { XpService } from '../xp/xp.service.js';
import { battleXpOf, DAILY_PAIR_LIMIT, decideOutcomes } from './battle-rules.js';

export type XpEarned = { userId: string; earned: number };

/** 대결이 끝나는 트랜잭션 안에서 결과·XP·오답노트를 확정한다 */
@Injectable()
export class BattleFinishService {
  constructor(private readonly xp: XpService) {}

  /** 커밋한 뒤 랭킹에 반영할 XP를 돌려준다 */
  async finalize(
    tx: Transaction,
    room: BattleRoom,
    battle: Battle,
    finishedAt: Date,
  ): Promise<XpEarned[]> {
    const players = await this.players(tx, room.id, battle.startedAt);
    if (players.length === 0) return [];
    const ids = players.map((player) => player.userId).sort();
    // 사용자 행을 먼저 같은 순서로 배타 잠금한다. 쌍 횟수·결과를 넣을 때 외래 키 검사로 공유 잠금을 잡은 뒤
    // XP 지급에서 배타 잠금으로 올리면, 그사이 같은 사용자를 잠그려는 다른 트랜잭션과 교착될 수 있다
    await tx
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, ids))
      .orderBy(asc(users.id))
      .for('update');
    const limitMs = battle.timeLimitSec * 1000;
    const totals = await tx
      .select({
        userId: battleAnswers.userId,
        score: sql<number>`CAST(SUM(${battleAnswers.score}) AS SIGNED)`,
        correct: sql<number>`CAST(SUM(${battleAnswers.correct}) AS SIGNED)`,
        timeMs: sql<number>`CAST(SUM(COALESCE(${battleAnswers.elapsedMs}, ${limitMs})) AS SIGNED)`,
        answered: sql<number>`CAST(COUNT(*) AS SIGNED)`,
        responded: sql<number>`CAST(COUNT(${battleAnswers.choiceIndex}) AS SIGNED)`,
      })
      .from(battleAnswers)
      .where(and(eq(battleAnswers.battleId, battle.id), inArray(battleAnswers.userId, ids)))
      .groupBy(battleAnswers.userId);
    const totalOf = new Map(totals.map((row) => [row.userId, row]));
    // 중도 이탈자의 남은 문항은 제한 시간 전체로 센다
    const results = decideOutcomes(
      players.map((player) => {
        const total = totalOf.get(player.userId);
        const answered = Number(total?.answered ?? 0);
        return {
          userId: player.userId,
          completed: player.state !== 'LEFT',
          score: Number(total?.score ?? 0),
          totalTimeMs:
            Number(total?.timeMs ?? 0) + Math.max(0, battle.questionCount - answered) * limitMs,
        };
      }),
    );

    const finishers = results.filter((result) => result.completed).map((r) => r.userId);
    const limited = await this.countPairs(tx, finishers, kstDate(finishedAt));
    const earned: XpEarned[] = [];
    const rows = [];
    // 사용자 행을 같은 순서로 잠근다
    for (const result of [...results].sort((a, b) => a.userId.localeCompare(b.userId))) {
      // 한 문항도 답하지 않은 완주자는 자리만 지킨 것으로 보고 XP를 주지 않는다 (순위·결과는 그대로)
      const idle = Number(totalOf.get(result.userId)?.responded ?? 0) === 0;
      const xp = idle
        ? { amount: 0, blockedReason: 'NOT_COMPLETED' as const }
        : battleXpOf(result.outcome, limited.has(result.userId));
      let xpEarned = 0;
      let blockedReason = xp.blockedReason;
      if (xp.amount > 0) {
        const grant = await this.xp.grant(
          tx,
          result.userId,
          [{ source: 'BATTLE', refKey: `battle:${battle.id}`, amount: xp.amount }],
          finishedAt,
        );
        xpEarned = grant.earned;
        if (grant.capped) blockedReason = 'DAILY_CAP';
        earned.push({ userId: result.userId, earned: grant.earned });
      }
      rows.push({
        battleId: battle.id,
        userId: result.userId,
        rank: result.rank,
        score: result.score,
        correctCount: Number(totalOf.get(result.userId)?.correct ?? 0),
        totalTimeMs: result.totalTimeMs,
        outcome: result.outcome,
        xpEarned,
        xpBlockedReason: blockedReason,
        finishedAt,
      });
    }
    await tx.insert(battleResults).values(rows);
    await this.saveWrongWords(tx, room, battle, ids, finishedAt);
    return earned;
  }

  /**
   * 대결에 참가한 사람: 끝날 때 방에 남아 있는 사람 + 시작한 뒤에 나간 사람.
   * 진행 중에는 새로 들어올 수 없어 시각 비교 없이 남은 사람을 그대로 쓴다 (서버 시계 차이에 흔들리지 않게)
   */
  private players(tx: Transaction, roomId: string, startedAt: Date) {
    return tx
      .select({ userId: battleRoomParticipants.userId, state: battleRoomParticipants.state })
      .from(battleRoomParticipants)
      .where(
        and(
          eq(battleRoomParticipants.roomId, roomId),
          or(
            eq(battleRoomParticipants.active, true),
            and(
              eq(battleRoomParticipants.state, 'LEFT'),
              gte(battleRoomParticipants.leftAt, startedAt),
            ),
          ),
        ),
      );
  }

  /**
   * 완주자끼리 오늘 함께 완주한 횟수를 하나씩 올린다. 모든 상대와 이미 하루 한도만큼 했으면 XP를 주지 않는다
   * (1:1이면 "같은 상대 하루 3번", 여럿이면 처음 만나는 상대가 하나라도 있으면 지급)
   */
  private async countPairs(
    tx: Transaction,
    finishers: string[],
    date: string,
  ): Promise<Set<string>> {
    const limited = new Set<string>();
    if (finishers.length < 2) return limited;
    const pairs = finishers.flatMap((userId) =>
      finishers
        .filter((opponentId) => opponentId !== userId)
        .map((opponentId) => ({ date, userId, opponentId, count: 1 })),
    );
    await tx
      .insert(battleDailyPairs)
      .values(pairs)
      .onDuplicateKeyUpdate({ set: { count: sql`${battleDailyPairs.count} + 1` } });
    const counts = await tx
      .select({ userId: battleDailyPairs.userId, count: battleDailyPairs.count })
      .from(battleDailyPairs)
      .where(
        and(
          eq(battleDailyPairs.date, date),
          inArray(battleDailyPairs.userId, finishers),
          inArray(battleDailyPairs.opponentId, finishers),
        ),
      );
    for (const userId of finishers) {
      const mine = counts.filter((row) => row.userId === userId);
      if (mine.every((row) => row.count > DAILY_PAIR_LIMIT)) limited.add(userId);
    }
    return limited;
  }

  /** 틀렸거나 답하지 않은 단어를 (단어, 문제 유형)별로 오답노트에 쌓는다. 같은 단어가 여러 번 나와도 한 번 */
  private async saveWrongWords(
    tx: Transaction,
    room: BattleRoom,
    battle: Battle,
    userIds: string[],
    now: Date,
  ): Promise<void> {
    const wrong = await tx
      .selectDistinct({ userId: battleAnswers.userId, wordId: battleQuestions.wordId })
      .from(battleAnswers)
      .innerJoin(
        battleQuestions,
        and(
          eq(battleQuestions.battleId, battleAnswers.battleId),
          eq(battleQuestions.idx, battleAnswers.idx),
        ),
      )
      .where(
        and(
          eq(battleAnswers.battleId, battle.id),
          eq(battleAnswers.correct, false),
          inArray(battleAnswers.userId, userIds),
        ),
      );
    await recordWrongWords(
      tx,
      wrong.map((row) => ({ ...row, packId: room.packId, questionType: room.questionType })),
      'BATTLE',
      now,
    );
  }
}
