import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, lt, ne, or, sql, sum } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException, CommonErrors } from '../../common/errors/app-exception.js';
import { decodeCursor, toCursorPage } from '../../common/pagination.js';
import { kstDate } from '../../common/time/kst.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import {
  battleAnswers,
  battleQuestions,
  battleResults,
  battleRooms,
  battles,
  users,
  words,
  xpLedger,
} from '../../infra/db/schema/index.js';
import { toUserSummary } from '../users/user-summary.js';
import type {
  BattleHistory,
  BattleHistoryItem,
  BattleHistoryQuery,
  BattleResult,
  Room,
} from './battle.schemas.js';

export const BattleErrors = {
  notFound: () =>
    new AppException('BATTLE_NOT_FOUND', '대결을 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
};

const HistoryCursor = z.object({ finishedAt: z.iso.datetime(), battleId: z.uuid() });

@Injectable()
export class BattleResultsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** 끝난 대결의 참가자(중도 이탈 포함)와 교사용 방 진행자만 본다 */
  async result(user: AuthUser, battleId: string): Promise<BattleResult> {
    const [row] = await this.db
      .select({ battle: battles, room: battleRooms })
      .from(battles)
      .innerJoin(battleRooms, eq(battleRooms.id, battles.roomId))
      .where(eq(battles.id, battleId));
    const finishedAt = row?.battle.phase === 'FINISHED' ? row.battle.finishedAt : null;
    if (!row || !finishedAt) throw BattleErrors.notFound();
    const { room } = row;
    const results = await this.loadRanking(battleId);
    const mine = results.find((r) => r.result.userId === user.userId)?.result;
    if (!mine && !(room.type === 'CLASS' && room.hostUserId === user.userId)) {
      throw CommonErrors.forbidden('참가하지 않은 대결입니다.');
    }

    const questions = await this.loadQuestions(battleId);
    const choiceOf = await this.myChoices(battleId, user.userId, Boolean(mine));

    return {
      battleId,
      roomType: room.type,
      finishedAt: finishedAt.toISOString(),
      settings: {
        packId: room.packId,
        packName: room.packName,
        questionType: room.questionType as Room['settings']['questionType'],
        questionCount: room.questionCount,
        timeLimitSec: room.timeLimitSec,
        maxParticipants: room.maxParticipants,
      },
      ranking: results.map(({ result, user: member }) => ({
        rank: result.rank,
        user: toUserSummary(member),
        score: result.score,
        correctCount: result.correctCount,
        totalTimeMs: result.totalTimeMs,
        outcome: result.outcome,
      })),
      me: mine
        ? {
            rank: mine.rank,
            score: mine.score,
            outcome: mine.outcome,
            xp: {
              earned: mine.xpEarned,
              blockedReason: mine.xpBlockedReason,
              todayTotal: await this.todayXp(user.userId),
            },
          }
        : null,
      questions: questions.map(({ question, word }) => {
        const myChoiceIndex = choiceOf.get(question.idx) ?? null;
        return {
          index: question.idx,
          word: {
            wordId: word.id,
            english: word.english,
            meanings: word.meanings,
            example: word.example,
          },
          choices: question.choices,
          answerIndex: question.answerIndex,
          myChoiceIndex,
          correct: mine ? myChoiceIndex === question.answerIndex : null,
        };
      }),
    };
  }

  /** 순위 순서대로 참가 결과와 사용자 요약 */
  private loadRanking(battleId: string) {
    return this.db
      .select({ result: battleResults, user: users })
      .from(battleResults)
      .innerJoin(users, eq(users.id, battleResults.userId))
      .where(eq(battleResults.battleId, battleId))
      .orderBy(
        sql`${battleResults.rank} IS NULL`,
        asc(battleResults.rank),
        desc(battleResults.score),
        asc(battleResults.totalTimeMs),
      );
  }

  private loadQuestions(battleId: string) {
    return this.db
      .select({ question: battleQuestions, word: words })
      .from(battleQuestions)
      .innerJoin(words, eq(words.id, battleQuestions.wordId))
      .where(eq(battleQuestions.battleId, battleId))
      .orderBy(asc(battleQuestions.idx));
  }

  /** 참가자가 아니면(교사 관람) 내가 고른 보기는 없다 */
  private async myChoices(battleId: string, userId: string, participated: boolean) {
    const answers = participated
      ? await this.db
          .select({ idx: battleAnswers.idx, choiceIndex: battleAnswers.choiceIndex })
          .from(battleAnswers)
          .where(and(eq(battleAnswers.battleId, battleId), eq(battleAnswers.userId, userId)))
      : [];
    return new Map(answers.map((a) => [a.idx, a.choiceIndex]));
  }

  /** 최신순. 요약은 전체 기록 기준 (승률·정답률은 완주한 대결만) */
  async history(user: AuthUser, query: BattleHistoryQuery): Promise<BattleHistory> {
    const mine = eq(battleResults.userId, user.userId);
    const completed = and(mine, ne(battleResults.outcome, 'LEFT'));
    const [totals] = await this.db.select({ total: count() }).from(battleResults).where(mine);
    const [finished] = await this.db
      .select({
        completed: count(),
        firsts: sql<number>`CAST(SUM(${battleResults.rank} = 1) AS SIGNED)`,
        accuracy: sql<string | null>`AVG(${battleResults.correctCount} / ${battles.questionCount})`,
      })
      .from(battleResults)
      .innerJoin(battles, eq(battles.id, battleResults.battleId))
      .where(completed);
    const completedCount = finished?.completed ?? 0;

    const cursor = query.cursor ? decodeCursor(query.cursor, HistoryCursor) : null;
    const before = cursor
      ? or(
          lt(battleResults.finishedAt, new Date(cursor.finishedAt)),
          and(
            eq(battleResults.finishedAt, new Date(cursor.finishedAt)),
            lt(battleResults.battleId, cursor.battleId),
          ),
        )
      : undefined;
    const rows = await this.db
      .select({ result: battleResults, packName: battleRooms.packName })
      .from(battleResults)
      .innerJoin(battles, eq(battles.id, battleResults.battleId))
      .innerJoin(battleRooms, eq(battleRooms.id, battles.roomId))
      .where(and(mine, before))
      .orderBy(desc(battleResults.finishedAt), desc(battleResults.battleId))
      .limit(query.size + 1);
    const ids = rows.map((row) => row.result.battleId);
    const counts =
      ids.length === 0
        ? []
        : await this.db
            .select({ battleId: battleResults.battleId, total: count() })
            .from(battleResults)
            .where(inArray(battleResults.battleId, ids))
            .groupBy(battleResults.battleId);
    const countOf = new Map(counts.map((row) => [row.battleId, row.total]));
    const items: BattleHistoryItem[] = rows.map(({ result, packName }) => ({
      battleId: result.battleId,
      finishedAt: result.finishedAt.toISOString(),
      packName,
      participantCount: countOf.get(result.battleId) ?? 0,
      rank: result.rank,
      score: result.score,
      outcome: result.outcome,
    }));
    const page = toCursorPage(items, query.size, (last) => ({
      finishedAt: last.finishedAt,
      battleId: last.battleId,
    }));
    return {
      ...page,
      summary: {
        total: totals?.total ?? 0,
        winRate: completedCount > 0 ? round3(Number(finished?.firsts ?? 0) / completedCount) : null,
        avgAccuracy:
          completedCount > 0 && finished?.accuracy !== null && finished?.accuracy !== undefined
            ? round3(Number(finished.accuracy))
            : null,
      },
    };
  }

  private async todayXp(userId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: sum(xpLedger.amount) })
      .from(xpLedger)
      .where(
        and(
          eq(xpLedger.userId, userId),
          eq(xpLedger.date, kstDate()),
          ne(xpLedger.source, 'ADMIN_ADJUST'),
        ),
      );
    return Number(row?.total ?? 0);
  }
}

const round3 = (value: number) => Math.round(value * 1000) / 1000;
