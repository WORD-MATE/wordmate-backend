import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CommonErrors } from '../../common/errors/app-exception.js';
import { kstDate } from '../../common/time/kst.js';
import { type Database, DB, type Transaction } from '../../infra/db/db.module.js';
import {
  dailyStudiedWords,
  dailyStudyStats,
  type StudySessionRow,
  studyAnswers,
  studyRecordItems,
  studyRecords,
  studySessionQuestions,
  studySessions,
  userStreaks,
  words,
} from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { type XpGrant, XpService } from '../xp/xp.service.js';
import type { CompleteResult, CompleteStudy } from './study.schemas.js';
import {
  answerXp,
  blockedReasonOf,
  countAnswers,
  isPackComplete,
  nextStreak,
  PACK_COMPLETE_XP,
} from './study-result.js';
import { isLive, StudyErrors } from './study-sessions.service.js';

const INSERT_CHUNK = 500;

@Injectable()
export class StudyCompleteService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly xp: XpService,
  ) {}

  /**
   * IN_PROGRESS → COMPLETED를 한 번만 처리하고, 같은 트랜잭션에서 기록·일별 통계·스트릭·XP를 남긴다.
   * 같은 Idempotency-Key로 다시 보내면 인터셉터가 저장한 결과를 돌려준다
   */
  async complete(user: AuthUser, sessionId: string, body: CompleteStudy): Promise<CompleteResult> {
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(studySessions)
        .where(eq(studySessions.id, sessionId))
        .for('update');
      if (!session || !isLive(session)) throw StudyErrors.notFound();
      if (session.userId !== user.userId) throw CommonErrors.forbidden();
      if (session.status !== 'IN_PROGRESS') throw StudyErrors.closed();

      const now = new Date();
      const today = kstDate(now);
      await tx
        .update(studySessions)
        .set({ status: 'COMPLETED', completedAt: now })
        .where(eq(studySessions.id, session.id));

      const answered = await tx
        .select({
          idx: studyAnswers.idx,
          correct: studyAnswers.correct,
          known: studyAnswers.known,
          counted: studyAnswers.counted,
          typedAnswer: studyAnswers.typedAnswer,
          wordId: studySessionQuestions.wordId,
          questionType: studySessionQuestions.questionType,
          english: words.english,
          meanings: words.meanings,
        })
        .from(studyAnswers)
        .innerJoin(
          studySessionQuestions,
          and(
            eq(studySessionQuestions.sessionId, studyAnswers.sessionId),
            eq(studySessionQuestions.idx, studyAnswers.idx),
          ),
        )
        .innerJoin(words, eq(words.id, studySessionQuestions.wordId))
        .where(eq(studyAnswers.sessionId, session.id))
        .orderBy(asc(studyAnswers.idx));

      const counts = countAnswers(session.mode, answered);
      const xp = await this.grantXp(tx, session, body, answered, today, now);

      const recordId = newId();
      await tx.insert(studyRecords).values({
        id: recordId,
        userId: user.userId,
        sessionId: session.id,
        source: session.source,
        packId: session.packId,
        mode: session.mode,
        direction: session.direction,
        reason: body.reason,
        ...counts,
        xpEarned: xp.earned,
        packCompleteBonus: xp.packCompleteBonus,
        completedAt: now,
        completedDate: today,
      });
      const items = answered.map((a) => ({
        recordId,
        idx: a.idx,
        wordId: a.wordId,
        english: a.english,
        meanings: a.meanings,
        questionType: a.questionType,
        correct: a.correct,
        known: a.known,
        userAnswer: a.typedAnswer,
      }));
      for (let i = 0; i < items.length; i += INSERT_CHUNK) {
        await tx.insert(studyRecordItems).values(items.slice(i, i + INSERT_CHUNK));
      }

      await this.addDailyStats(tx, user.userId, today, session, answered, xp.earned);
      const streak = answered.length > 0 ? await this.updateStreak(tx, user.userId, today) : null;

      return {
        recordId,
        ...counts,
        xp: { earned: xp.earned, blockedReason: xp.blockedReason, todayTotal: xp.todayTotal },
        packCompleteBonus: xp.packCompleteBonus,
        streak,
      };
    });
  }

  private async grantXp(
    tx: Transaction,
    session: StudySessionRow,
    body: CompleteStudy,
    answered: { correct: boolean | null; known: boolean | null; counted: boolean }[],
    today: string,
    now: Date,
  ) {
    const fromAnswers = answerXp(session.mode, session.source, answered);
    const bonusEligible = isPackComplete({
      ...session,
      answered: answered.length,
      reason: body.reason,
    });

    const grants: XpGrant[] = [];
    if (fromAnswers.amount > 0) {
      grants.push({
        source: session.source === 'WRONG_NOTE' ? 'WRONG_NOTE_REVIEW' : 'STUDY',
        refKey: `session:${session.id}`,
        amount: fromAnswers.amount,
      });
    }
    // 같은 팩 완주 보너스는 하루 1회 (refKey에 날짜를 넣어 원장 유니크로 막는다)
    if (bonusEligible) {
      grants.push({
        source: 'PACK_COMPLETE',
        refKey: `pack:${session.packId}:${today}`,
        amount: PACK_COMPLETE_XP,
      });
    }
    const result = await this.xp.grant(tx, session.userId, grants, now);
    const bonusGranted = bonusEligible ? result.granted.at(-1) : undefined;
    const bonusRepeated = bonusEligible && bonusGranted === null;
    return {
      earned: result.earned,
      todayTotal: result.todayTotal,
      packCompleteBonus: typeof bonusGranted === 'number' && bonusGranted > 0,
      blockedReason: blockedReasonOf({
        capped: result.capped,
        bonusRepeated,
        tooFast: fromAnswers.tooFast,
        quit: body.reason === 'QUIT',
      }),
    };
  }

  private async addDailyStats(
    tx: Transaction,
    userId: string,
    date: string,
    session: StudySessionRow,
    answered: { correct: boolean | null; wordId: string }[],
    xpEarned: number,
  ): Promise<void> {
    const graded = session.mode === 'FLASHCARD' ? 0 : answered.length;
    const correct = answered.filter((a) => a.correct === true).length;
    await tx
      .insert(dailyStudyStats)
      .values({
        userId,
        date,
        solvedCount: answered.length,
        gradedCount: graded,
        correctCount: correct,
        sessionsCompleted: 1,
        xpStudy: xpEarned,
      })
      .onDuplicateKeyUpdate({
        set: {
          solvedCount: sql`${dailyStudyStats.solvedCount} + ${answered.length}`,
          gradedCount: sql`${dailyStudyStats.gradedCount} + ${graded}`,
          correctCount: sql`${dailyStudyStats.correctCount} + ${correct}`,
          sessionsCompleted: sql`${dailyStudyStats.sessionsCompleted} + 1`,
          xpStudy: sql`${dailyStudyStats.xpStudy} + ${xpEarned}`,
        },
      });
    const wordIds = [...new Set(answered.map((a) => a.wordId))];
    for (let i = 0; i < wordIds.length; i += INSERT_CHUNK) {
      await tx
        .insert(dailyStudiedWords)
        .ignore()
        .values(wordIds.slice(i, i + INSERT_CHUNK).map((wordId) => ({ userId, date, wordId })));
    }
  }

  /** XP 지급에서 사용자 행을 이미 잠갔으므로 같은 사용자의 스트릭 갱신은 차례로 처리된다 */
  private async updateStreak(tx: Transaction, userId: string, today: string) {
    const target = and(eq(userStreaks.userId, userId), eq(userStreaks.kind, 'STUDY'));
    const [current] = await tx.select().from(userStreaks).where(target);
    const next = nextStreak(current ?? null, today);
    if (current) {
      if (next.increased) {
        await tx
          .update(userStreaks)
          .set({ current: next.current, best: next.best, lastDate: next.lastDate })
          .where(target);
      }
    } else {
      await tx.insert(userStreaks).values({
        userId,
        kind: 'STUDY',
        current: next.current,
        best: next.best,
        lastDate: next.lastDate,
      });
    }
    return { current: next.current, increased: next.increased };
  }
}
