import { HttpStatus, Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { and, asc, count, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppException } from '../../common/errors/app-exception.js';
import { type Database, DB, type Transaction } from '../../infra/db/db.module.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import {
  type Battle,
  type BattleRoom,
  battleAnswers,
  battleQuestions,
  battleRoomParticipants,
  battleRooms,
  battles,
  words,
} from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { BadgesService } from '../badges/badges.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RankingService } from '../ranking/ranking.service.js';
import { type RealtimeContext, RealtimeService } from '../realtime/realtime.service.js';
import { CHOICE_COUNT } from '../study/question-builder.js';
import { BattleQueue } from './battle.queue.js';
import { BattleFinishService, type XpEarned } from './battle-finish.service.js';
import { buildBattleQuestions, rankPlayers, scoreOf } from './battle-rules.js';
import { activeParticipants, roomMembers } from './room-members.js';

/** 문항이 끝나고 결과를 보여 주는 시간 */
export const RESULT_DISPLAY_MS = 2000;

export const PlayErrors = {
  notPlaying: () =>
    new AppException('BATTLE_NOT_IN_PROGRESS', '진행 중인 대결이 없습니다.', HttpStatus.CONFLICT),
  closed: () =>
    new AppException('ANSWER_CLOSED', '지금은 이 문항에 답할 수 없습니다.', HttpStatus.CONFLICT),
  duplicate: () =>
    new AppException('ANSWER_ALREADY_SUBMITTED', '이미 답한 문항입니다.', HttpStatus.CONFLICT),
};

const AnswerPayload = z.object({
  questionIndex: z.number().int().min(0),
  choiceIndex: z
    .number()
    .int()
    .min(0)
    .max(CHOICE_COUNT - 1),
});

type Event = { userIds: string[]; type: string; payload: unknown };
type Locked = { room: BattleRoom; battle: Battle };

/**
 * 대결 문항 진행. 문항 시작·종료는 방 행 → 대결 행 순서로 잠가 서버가 여러 대여도 한 번만 일어나고,
 * 시각은 BullMQ 지연 작업이 맞춘다. 같은 작업이 다시 돌아도 현재 상태와 맞지 않으면 아무것도 하지 않는다
 */
@Injectable()
export class PlayService implements OnModuleInit {
  private readonly logger = new Logger(PlayService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly realtime: RealtimeService,
    private readonly queue: BattleQueue,
    private readonly finisher: BattleFinishService,
    private readonly ranking: RankingService,
    private readonly badges: BadgesService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.realtime.handle('ANSWER_SUBMIT', AnswerPayload, (ctx, p) =>
      this.submit(ctx, p.questionIndex, p.choiceIndex, new Date()),
    );
  }

  /** 방을 진행 중으로 바꾸는 트랜잭션 안에서 문항을 만들어 고정한다. 보기를 만들 수 없으면 null */
  async createBattle(tx: Transaction, room: BattleRoom): Promise<string | null> {
    const packWords = await tx
      .select({
        id: words.id,
        packId: words.packId,
        english: words.english,
        meanings: words.meanings,
        derivatives: words.derivatives,
      })
      .from(words)
      .where(and(eq(words.packId, room.packId), isNull(words.deletedAt)))
      .orderBy(asc(words.id));
    const direction = room.questionType.startsWith('EN_TO_KO') ? 'EN_TO_KO' : 'KO_TO_EN';
    const questions = buildBattleQuestions(packWords, room.questionCount, direction);
    if (!questions) return null;
    const battleId = newId();
    await tx.insert(battles).values({
      id: battleId,
      roomId: room.id,
      questionCount: room.questionCount,
      timeLimitSec: room.timeLimitSec,
      startedAt: new Date(),
    });
    await tx.insert(battleQuestions).values(
      questions.map((question) => ({
        battleId,
        idx: question.idx,
        wordId: question.wordId,
        questionType: room.questionType,
        prompt: question.prompt,
        choices: question.choices,
        answerIndex: question.answerIndex,
      })),
    );
    return battleId;
  }

  async battleIdOf(roomId: string): Promise<string | null> {
    const [battle] = await this.db
      .select({ id: battles.id })
      .from(battles)
      .where(eq(battles.roomId, roomId));
    return battle?.id ?? null;
  }

  private async roomIdOf(battleId: string): Promise<string | null> {
    const [ref] = await this.db
      .select({ roomId: battles.roomId })
      .from(battles)
      .where(eq(battles.id, battleId));
    return ref?.roomId ?? null;
  }

  /** 문항을 시작하고 마감 작업을 예약한다. 마지막 문항 다음이면 대결을 끝낸다 */
  async startQuestion(battleId: string, idx: number): Promise<void> {
    const roomId = await this.roomIdOf(battleId);
    if (!roomId) return;
    const outcome = await this.db.transaction(async (tx) => {
      const locked = await this.lock(tx, roomId, battleId);
      if (!locked) return null;
      const { room, battle } = locked;
      // 예약하다 실패해 작업이 다시 돌면 알림 없이 마감 작업만 다시 예약한다
      if (battle.currentIndex === idx && battle.phase === 'QUESTION') {
        return { deadlineAt: battle.deadlineAt as Date, events: [] };
      }
      if (battle.currentIndex !== idx - 1) return null;
      if (battle.phase !== 'READY' && battle.phase !== 'RESULT') return null;
      if (idx >= battle.questionCount) {
        const { event, xp, finishedAt } = await this.finish(tx, locked);
        return { deadlineAt: null, events: [event], xp, finishedAt };
      }

      const startedAt = new Date();
      const deadlineAt = new Date(startedAt.getTime() + battle.timeLimitSec * 1000);
      await tx
        .update(battles)
        .set({ currentIndex: idx, phase: 'QUESTION', questionStartedAt: startedAt, deadlineAt })
        .where(eq(battles.id, battleId));
      const started = { ...battle, currentIndex: idx, deadlineAt };
      return {
        deadlineAt,
        events: [
          {
            userIds: await roomMembers(tx, room),
            type: 'QUESTION_STARTED',
            payload: await this.questionPayload(tx, started),
          },
        ],
      };
    });
    if (!outcome) return;
    await this.publish(outcome.events);
    // 랭킹 반영은 알림 뒤에 (Valkey가 느려도 끝났다는 알림이 늦지 않게, 실패는 addXp가 삼킨다)
    const { xp, finishedAt } = outcome;
    if (xp && finishedAt) {
      await Promise.all(
        xp.map(({ userId, earned }) => this.ranking.addXp(userId, earned, finishedAt)),
      );
      // 끝까지 남은 참가자 (XP 0 포함)
      await Promise.all(xp.map(({ userId }) => this.badges.evaluate(userId)));
      await this.notifyResult(
        battleId,
        xp.map(({ userId }) => userId),
      );
    }
    if (outcome.deadlineAt) await this.queue.scheduleQuestionEnd(battleId, idx, outcome.deadlineAt);
  }

  /** 끝까지 남은 참가자에게 결과 알림 (대결 중 배너는 앱이 숨긴다). 실패해도 대결은 끝난 그대로 */
  private async notifyResult(battleId: string, userIds: string[]): Promise<void> {
    if (userIds.length === 0) return;
    await this.notifications
      .notify(userIds, {
        type: 'BATTLE_RESULT',
        title: '대결 결과',
        body: '대결이 끝났어요. 결과를 확인해 보세요.',
        route: `/battles/${battleId}/result`,
      })
      .catch((error: unknown) =>
        this.logger.warn(`대결 결과 알림 실패 (${battleId}): ${String(error)}`),
      );
  }

  /**
   * 마감 또는 전원 응답 때. 미응답을 남기고 사람마다 결과를 보낸 뒤 2초 뒤 다음 문항을 예약한다.
   * 마감 작업(byDeadline)이 서버 시계 차이로 일찍 돌면 끝내지 않고 마감 시각에 다시 예약한다
   */
  async endQuestion(battleId: string, idx: number, byDeadline = false): Promise<void> {
    const roomId = await this.roomIdOf(battleId);
    if (!roomId) return;
    const outcome = await this.db.transaction(async (tx) => {
      const locked = await this.lock(tx, roomId, battleId);
      if (!locked || locked.battle.currentIndex !== idx) return null;
      const { room, battle } = locked;
      if (battle.phase === 'RESULT') return { events: [] };
      if (battle.phase !== 'QUESTION') return null;
      const deadline = battle.deadlineAt;
      if (byDeadline && deadline && deadline.getTime() > Date.now()) return { retryAt: deadline };

      const players = (await activeParticipants(tx, room.id)).map((row) => row.userId);
      const answered = new Set(
        (
          await tx
            .select({ userId: battleAnswers.userId })
            .from(battleAnswers)
            .where(and(eq(battleAnswers.battleId, battleId), eq(battleAnswers.idx, idx)))
        ).map((row) => row.userId),
      );
      const missing = players.filter((userId) => !answered.has(userId));
      if (missing.length > 0) {
        await tx.insert(battleAnswers).values(
          missing.map((userId) => ({
            battleId,
            idx,
            userId,
            choiceIndex: null,
            receivedAt: null,
            elapsedMs: null,
            correct: false,
            score: 0,
          })),
        );
      }
      await tx.update(battles).set({ phase: 'RESULT' }).where(eq(battles.id, battleId));
      return { events: await this.resultEvents(tx, battle, players, await roomMembers(tx, room)) };
    });
    if (!outcome) return;
    if (outcome.retryAt) {
      await this.queue.scheduleQuestionEnd(battleId, idx, outcome.retryAt, true);
      return;
    }
    await this.publish(outcome.events ?? []);
    await this.queue.scheduleQuestionStart(
      battleId,
      idx + 1,
      new Date(Date.now() + RESULT_DISPLAY_MS),
    );
  }

  /** 서버가 받은 시각으로 판정한다. 마감이 지났거나 다른 문항이면 받지 않는다 */
  async submit(
    ctx: RealtimeContext,
    questionIndex: number,
    choiceIndex: number,
    receivedAt: Date,
  ): Promise<void> {
    const accepted = await this.db.transaction(async (tx) => {
      const [playing] = await tx
        .select({
          battleId: battles.id,
          roomId: battleRooms.id,
          state: battleRoomParticipants.state,
        })
        .from(battleRoomParticipants)
        .innerJoin(battleRooms, eq(battleRooms.id, battleRoomParticipants.roomId))
        .innerJoin(battles, eq(battles.roomId, battleRooms.id))
        .where(
          and(
            eq(battleRoomParticipants.userId, ctx.userId),
            eq(battleRoomParticipants.active, true),
            eq(battleRooms.status, 'IN_PROGRESS'),
          ),
        );
      if (!playing) throw PlayErrors.notPlaying();
      // 공유 잠금: 답끼리는 동시에 받고, 문항 종료(배타 잠금)와는 순서를 지킨다
      const [battle] = await tx
        .select()
        .from(battles)
        .where(eq(battles.id, playing.battleId))
        .for('share');
      if (
        !battle?.deadlineAt ||
        !battle.questionStartedAt ||
        battle.phase !== 'QUESTION' ||
        battle.currentIndex !== questionIndex ||
        receivedAt > battle.deadlineAt
      ) {
        throw PlayErrors.closed();
      }
      const [question] = await tx
        .select({ answerIndex: battleQuestions.answerIndex })
        .from(battleQuestions)
        .where(
          and(eq(battleQuestions.battleId, battle.id), eq(battleQuestions.idx, questionIndex)),
        );
      const correct = question?.answerIndex === choiceIndex;
      const limitMs = battle.timeLimitSec * 1000;
      try {
        await tx.insert(battleAnswers).values({
          battleId: battle.id,
          idx: questionIndex,
          userId: ctx.userId,
          choiceIndex,
          receivedAt,
          elapsedMs: Math.max(0, receivedAt.getTime() - battle.questionStartedAt.getTime()),
          correct,
          score: scoreOf(correct, battle.deadlineAt.getTime() - receivedAt.getTime(), limitMs),
        });
      } catch (error) {
        if (isDuplicateKeyError(error)) throw PlayErrors.duplicate();
        throw error;
      }
      return { battleId: battle.id, roomId: playing.roomId, away: playing.state !== 'CONNECTED' };
    });
    ctx.reply('ANSWER_ACCEPTED', { questionIndex });
    if (accepted.away) await this.markBack(accepted.roomId, ctx.userId);
    await this.endIfAllAnswered(accepted.battleId, questionIndex);
  }

  /**
   * 다시 접속해 ROOM_RESUME 없이 답하면 돌아온 것으로 본다 (끊김 유예로 내보내지 않게).
   * 유예 작업은 참가자 행을 잠그고 상태를 다시 보므로 이 갱신과 겹쳐도 한쪽만 이긴다
   */
  private async markBack(roomId: string, userId: string): Promise<void> {
    const [result] = await this.db
      .update(battleRoomParticipants)
      .set({ state: 'CONNECTED', disconnectedAt: null })
      .where(
        and(
          eq(battleRoomParticipants.roomId, roomId),
          eq(battleRoomParticipants.userId, userId),
          eq(battleRoomParticipants.active, true),
          eq(battleRoomParticipants.state, 'DISCONNECTED'),
        ),
      );
    if (result.affectedRows === 0) return;
    const [room] = await this.db.select().from(battleRooms).where(eq(battleRooms.id, roomId));
    if (!room) return;
    const others = (await roomMembers(this.db, room)).filter((id) => id !== userId);
    await this.publish([
      {
        userIds: others,
        type: 'PARTICIPANT_STATE',
        payload: { roomId, userId, state: 'CONNECTED' },
      },
    ]);
  }

  /** 나가기·유예 만료로 인원이 줄면 남은 사람이 다 답했는지 다시 본다 */
  async afterLeave(roomId: string): Promise<void> {
    const [battle] = await this.db.select().from(battles).where(eq(battles.roomId, roomId));
    if (battle?.phase === 'QUESTION') await this.endIfAllAnswered(battle.id, battle.currentIndex);
  }

  /** 재접속·구독 직후 진행 중인 문항(또는 결과)을 그 연결에 다시 보낸다 */
  async resume(ctx: RealtimeContext, roomId: string): Promise<void> {
    const [battle] = await this.db.select().from(battles).where(eq(battles.roomId, roomId));
    if (!battle) return;
    if (battle.phase === 'QUESTION') {
      ctx.reply('QUESTION_STARTED', await this.questionPayload(this.db, battle));
      const [mine] = await this.db
        .select({ userId: battleAnswers.userId })
        .from(battleAnswers)
        .where(this.answerOf(battle.id, battle.currentIndex, ctx.userId));
      if (mine) ctx.reply('ANSWER_ACCEPTED', { questionIndex: battle.currentIndex });
      return;
    }
    if (battle.phase === 'RESULT') {
      const players = (await activeParticipants(this.db, roomId)).map((row) => row.userId);
      const [event] = await this.resultEvents(this.db, battle, players, [ctx.userId]);
      if (event) ctx.reply(event.type, event.payload);
    }
  }

  /** 실패해도 답·나가기는 이미 끝났으므로 알리지 않는다 (마감 작업이 문항을 끝낸다) */
  private async endIfAllAnswered(battleId: string, idx: number): Promise<void> {
    await this.tryEndEarly(battleId, idx).catch((error: unknown) =>
      this.logger.warn(`문항 조기 종료 실패 (${battleId}#${idx}): ${String(error)}`),
    );
  }

  private async tryEndEarly(battleId: string, idx: number): Promise<void> {
    const [battle] = await this.db
      .select({ roomId: battles.roomId, phase: battles.phase, currentIndex: battles.currentIndex })
      .from(battles)
      .where(eq(battles.id, battleId));
    if (battle?.phase !== 'QUESTION' || battle.currentIndex !== idx) return;
    const players = (await activeParticipants(this.db, battle.roomId)).map((row) => row.userId);
    if (players.length > 0) {
      const [answered] = await this.db
        .select({ total: count() })
        .from(battleAnswers)
        .where(
          and(
            eq(battleAnswers.battleId, battleId),
            eq(battleAnswers.idx, idx),
            inArray(battleAnswers.userId, players),
          ),
        );
      if ((answered?.total ?? 0) < players.length) return;
    }
    await this.endQuestion(battleId, idx);
  }

  /**
   * 방 행을 먼저 잠근 뒤 대결 행을 잠근다 (나가기 등 방을 먼저 잠그는 경로와 순서를 맞춰 교착을 피한다).
   * 트랜잭션의 첫 문장이 잠금 읽기여야 그 뒤 일반 읽기(참가자·답)가 잠금을 얻은 뒤의 데이터를 본다
   * (REPEATABLE READ는 첫 일반 읽기 때 스냅숏을 잡는다). 그래서 바뀌지 않는 room_id는 트랜잭션 밖에서 읽는다
   */
  private async lock(tx: Transaction, roomId: string, battleId: string): Promise<Locked | null> {
    const [room] = await tx
      .select()
      .from(battleRooms)
      .where(eq(battleRooms.id, roomId))
      .for('update');
    if (room?.status !== 'IN_PROGRESS') return null;
    const [battle] = await tx.select().from(battles).where(eq(battles.id, battleId)).for('update');
    if (!battle || battle.phase === 'FINISHED') return null;
    return { room, battle };
  }

  /** 결과·XP·오답노트를 확정하고 방을 끝낸다. 랭킹 반영은 커밋한 뒤에 */
  private async finish(
    tx: Transaction,
    { room, battle }: Locked,
  ): Promise<{ event: Event; xp: XpEarned[]; finishedAt: Date }> {
    const finishedAt = new Date();
    const members = await roomMembers(tx, room);
    const xp = await this.finisher.finalize(tx, room, battle, finishedAt);
    await tx
      .update(battles)
      .set({ phase: 'FINISHED', finishedAt })
      .where(eq(battles.id, battle.id));
    await tx
      .update(battleRooms)
      .set({ status: 'FINISHED', finishedAt })
      .where(eq(battleRooms.id, room.id));
    await tx
      .update(battleRoomParticipants)
      .set({ active: false })
      .where(eq(battleRoomParticipants.roomId, room.id));
    return {
      event: { userIds: members, type: 'BATTLE_FINISHED', payload: { battleId: battle.id } },
      xp,
      finishedAt,
    };
  }

  private async questionPayload(executor: Database | Transaction, battle: Battle) {
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
  private async resultEvents(
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

  private answerOf(battleId: string, idx: number, userId: string) {
    return and(
      eq(battleAnswers.battleId, battleId),
      eq(battleAnswers.idx, idx),
      eq(battleAnswers.userId, userId),
    );
  }

  private async publish(events: Event[]): Promise<void> {
    for (const event of events) {
      await this.realtime
        .sendToUsers(event.userIds, event.type, event.payload)
        .catch((error: unknown) => this.logger.warn(`대결 알림 실패: ${String(error)}`));
    }
  }
}
