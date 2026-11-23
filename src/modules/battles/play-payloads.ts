import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../../infra/db/db.module.js';
import { type Battle, battleAnswers, battleQuestions } from '../../infra/db/schema/index.js';
import { rankPlayers } from './battle-rules.js';

export type Event = { userIds: string[]; type: string; payload: unknown };

export async function questionPayload(executor: Database | Transaction, battle: Battle) {
  const [question] = await executor
    .select()
    .from(battleQuestions)
    .where(
      and(eq(battleQuestions.battleId, battle.id), eq(battleQuestions.idx, battle.currentIndex)),
    );
  return {
    questionIndex: battle.currentIndex,
    total: battle.questionCount,
    prompt: question?.prompt,
    choices: question?.choices,
    deadlineAt: battle.deadlineAt?.toISOString(),
  };
}

/**
 * 사람마다 다른 QUESTION_ENDED. 순위는 남아 있는 참가자끼리 누적 점수로 매기고,
 * 총 풀이 시간에서 미응답 문항은 제한 시간 전체로 센다
 */
export async function resultEvents(
  executor: Database | Transaction,
  battle: Battle,
  players: string[],
  recipients: string[],
): Promise<Event[]> {
  const idx = battle.currentIndex;
  const [question] = await executor
    .select({ answerIndex: battleQuestions.answerIndex })
    .from(battleQuestions)
    .where(and(eq(battleQuestions.battleId, battle.id), eq(battleQuestions.idx, idx)));
  const totals =
    players.length === 0
      ? []
      : await executor
          .select({
            userId: battleAnswers.userId,
            score: sql<number>`CAST(SUM(${battleAnswers.score}) AS SIGNED)`,
            totalTimeMs: sql<number>`CAST(SUM(COALESCE(${battleAnswers.elapsedMs}, ${battle.timeLimitSec * 1000})) AS SIGNED)`,
          })
          .from(battleAnswers)
          .where(
            and(
              eq(battleAnswers.battleId, battle.id),
              lte(battleAnswers.idx, idx),
              inArray(battleAnswers.userId, players),
            ),
          )
          .groupBy(battleAnswers.userId);
  const totalOf = new Map(totals.map((row) => [row.userId, row]));
  const ranking = rankPlayers(
    players.map((userId) => ({
      userId,
      score: Number(totalOf.get(userId)?.score ?? 0),
      totalTimeMs: Number(totalOf.get(userId)?.totalTimeMs ?? 0),
    })),
  );
  const answers =
    players.length === 0
      ? []
      : await executor
          .select()
          .from(battleAnswers)
          .where(
            and(
              eq(battleAnswers.battleId, battle.id),
              eq(battleAnswers.idx, idx),
              inArray(battleAnswers.userId, players),
            ),
          );
  const answerOf = new Map(answers.map((row) => [row.userId, row]));
  const rankOf = new Map(ranking.map((row) => [row.userId, row]));
  const publicRanking = ranking.map(({ userId, rank, score }) => ({ userId, rank, score }));
  return recipients.map((userId) => {
    const answer = answerOf.get(userId);
    const total = rankOf.get(userId);
    return {
      userIds: [userId],
      type: 'QUESTION_ENDED',
      payload: {
        questionIndex: idx,
        answerIndex: question?.answerIndex,
        myResult:
          answer && total
            ? {
                choiceIndex: answer.choiceIndex,
                correct: answer.correct,
                score: answer.score,
                totalScore: total.score,
                rank: total.rank,
              }
            : null,
        ranking: publicRanking,
      },
    };
  });
}

export function answerOf(battleId: string, idx: number, userId: string) {
  return and(
    eq(battleAnswers.battleId, battleId),
    eq(battleAnswers.idx, idx),
    eq(battleAnswers.userId, userId),
  );
}
