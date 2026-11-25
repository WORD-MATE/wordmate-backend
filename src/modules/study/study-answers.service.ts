import { Inject, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CommonErrors } from '../../common/errors/app-exception.js';
import { kstDate } from '../../common/time/kst.js';
import { type Database, DB, type Transaction } from '../../infra/db/db.module.js';
import {
  type StudyQuestionRow,
  type StudySessionRow,
  studyAnswers,
  studySessionQuestions,
  studySessions,
  userWordProgress,
  words,
  wrongNotes,
} from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import {
  GRADUATE_STREAK,
  gradeTyping,
  MIN_COUNTED_ELAPSED_MS,
  nextProgress,
  nextReview,
} from './grading.js';
import type { AnswerResult, SubmitAnswer } from './study.schemas.js';
import { isLive, StudyErrors, sessionExpiry } from './study-sessions.service.js';

const missingAnswer = (field: string) =>
  CommonErrors.invalidRequest({ field }, '문항 방식에 맞는 답을 보내 주세요.');

@Injectable()
export class StudyAnswersService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * 채점하고 답안·오답노트·암기 진행을 한 트랜잭션에 반영한다.
   * 세션 행을 잠가 같은 학습의 답안을 차례로 처리한다 (남은 문항 수·중복 제출 판정)
   */
  async submit(user: AuthUser, sessionId: string, body: SubmitAnswer): Promise<AnswerResult> {
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(studySessions)
        .where(eq(studySessions.id, sessionId))
        .for('update');
      if (!session || !isLive(session)) throw StudyErrors.notFound();
      if (session.userId !== user.userId) throw CommonErrors.forbidden();
      if (session.status !== 'IN_PROGRESS') throw StudyErrors.closed();

      const [question] = await tx
        .select()
        .from(studySessionQuestions)
        .where(
          and(
            eq(studySessionQuestions.sessionId, session.id),
            eq(studySessionQuestions.idx, body.index),
          ),
        );
      if (!question) {
        throw CommonErrors.invalidRequest({ field: 'index', total: session.total });
      }

      const [previous] = await tx
        .select({ idx: studyAnswers.idx })
        .from(studyAnswers)
        .where(and(eq(studyAnswers.sessionId, session.id), eq(studyAnswers.idx, body.index)));
      // FLASHCARD는 다시 보내면 덮어쓴다
      if (previous && session.mode !== 'FLASHCARD') throw StudyErrors.alreadySubmitted();

      const graded = this.grade(session, question, body);
      const counted = body.elapsedMs >= MIN_COUNTED_ELAPSED_MS;
      await this.saveAnswer(tx, session, body, { graded, counted, replaced: Boolean(previous) });
      // 다시 보낸 플래시카드는 답만 고치고 진도는 처음 답 기준으로 둔다 (다시 보낼 때마다 쌓이지 않게)
      const word = previous
        ? null
        : await this.recordProgress(tx, user.userId, session, question, {
            correct: graded,
            counted,
          });

      return {
        index: body.index,
        correct: session.mode === 'FLASHCARD' ? null : graded,
        correctAnswer:
          session.mode === 'TYPING' && !graded && word
            ? { english: word.english, meanings: word.meanings }
            : null,
        counted,
      };
    });
  }

  /** 답을 새로 쓰거나(다시 보낸 플래시카드는 덮어쓴다) 고친 뒤 대결과 같은 방식으로 세션 진행 수를 맞춘다 */
  private async saveAnswer(
    tx: Transaction,
    session: StudySessionRow,
    body: SubmitAnswer,
    verdict: { graded: boolean; counted: boolean; replaced: boolean },
  ): Promise<void> {
    const answer = {
      choiceIndex: session.mode === 'CHOICE' ? (body.choiceIndex ?? null) : null,
      typedAnswer: session.mode === 'TYPING' ? (body.typedAnswer ?? null) : null,
      known: session.mode === 'FLASHCARD' ? (body.known ?? null) : null,
      correct: session.mode === 'FLASHCARD' ? null : verdict.graded,
      counted: verdict.counted,
      elapsedMs: body.elapsedMs,
      submittedAt: new Date(),
    };
    if (verdict.replaced) {
      await tx
        .update(studyAnswers)
        .set(answer)
        .where(and(eq(studyAnswers.sessionId, session.id), eq(studyAnswers.idx, body.index)));
    } else {
      await tx.insert(studyAnswers).values({ sessionId: session.id, idx: body.index, ...answer });
    }
    await tx
      .update(studySessions)
      .set({
        answeredCount: verdict.replaced ? session.answeredCount : session.answeredCount + 1,
        expiresAt: sessionExpiry(),
      })
      .where(eq(studySessions.id, session.id));
  }

  /** 오답노트·학습 진도를 갱신하고 정답 공개에 쓸 단어를 돌려준다 */
  private async recordProgress(
    tx: Transaction,
    userId: string,
    session: StudySessionRow,
    question: StudyQuestionRow,
    verdict: { correct: boolean; counted: boolean },
  ) {
    const [word] = await tx
      .select({ packId: words.packId, english: words.english, meanings: words.meanings })
      .from(words)
      .where(eq(words.id, question.wordId));
    if (word) {
      if (question.questionType) {
        await this.updateWrongNote(tx, userId, session, question, word.packId, verdict);
      }
      await this.updateProgress(tx, userId, session, question.wordId, word.packId, verdict);
    }
    return word;
  }

  /** FLASHCARD는 "알아요"를 맞힌 것으로 본다 (암기 진행용) */
  private grade(session: StudySessionRow, question: StudyQuestionRow, body: SubmitAnswer) {
    switch (session.mode) {
      case 'CHOICE':
        if (body.choiceIndex === undefined) throw missingAnswer('choiceIndex');
        return body.choiceIndex === question.answerIndex;
      case 'TYPING':
        if (!body.typedAnswer?.trim()) throw missingAnswer('typedAnswer');
        return gradeTyping(body.typedAnswer, session.direction, question.acceptedAnswers ?? []);
      case 'FLASHCARD':
        if (body.known === undefined) throw missingAnswer('known');
        return body.known;
    }
  }

  /**
   * 틀리면 (단어, 문제 유형) 오답에 쌓고 연속 정답을 0으로 (졸업했던 항목은 다시 ACTIVE).
   * 맞히면 같은 방식의 ACTIVE 오답만 연속 정답 +1, 2번이면 자동 졸업. 너무 빨리 낸 정답은 세지 않는다
   */
  private async updateWrongNote(
    tx: Transaction,
    userId: string,
    session: StudySessionRow,
    question: StudyQuestionRow,
    packId: string,
    answer: { correct: boolean; counted: boolean },
  ): Promise<void> {
    const questionType = question.questionType;
    if (!questionType) return;
    const target = and(
      eq(wrongNotes.userId, userId),
      eq(wrongNotes.wordId, question.wordId),
      eq(wrongNotes.questionType, questionType),
    );
    const now = new Date();
    if (!answer.correct) {
      await tx
        .insert(wrongNotes)
        .values({
          id: newId(),
          userId,
          wordId: question.wordId,
          packId,
          questionType,
          source: 'STUDY',
          lastSessionId: session.id,
          firstWrongAt: now,
          lastWrongAt: now,
        })
        .onDuplicateKeyUpdate({
          set: {
            status: 'ACTIVE',
            wrongCount: sql`${wrongNotes.wrongCount} + 1`,
            consecutiveCorrect: 0,
            source: 'STUDY',
            lastSessionId: session.id,
            lastWrongAt: now,
            graduatedAt: null,
          },
        });
      return;
    }
    if (!answer.counted) return;
    const [note] = await tx
      .select({ id: wrongNotes.id, consecutiveCorrect: wrongNotes.consecutiveCorrect })
      .from(wrongNotes)
      .where(and(target, eq(wrongNotes.status, 'ACTIVE')))
      .for('update');
    if (!note) return;
    const consecutiveCorrect = note.consecutiveCorrect + 1;
    const graduated = consecutiveCorrect >= GRADUATE_STREAK;
    await tx
      .update(wrongNotes)
      .set({
        consecutiveCorrect,
        status: graduated ? 'GRADUATED' : 'ACTIVE',
        graduatedAt: graduated ? now : null,
      })
      .where(eq(wrongNotes.id, note.id));
  }

  private async updateProgress(
    tx: Transaction,
    userId: string,
    session: StudySessionRow,
    wordId: string,
    packId: string,
    answer: { correct: boolean; counted: boolean },
  ): Promise<void> {
    const target = and(eq(userWordProgress.userId, userId), eq(userWordProgress.wordId, wordId));
    const now = new Date();
    // 없는 행을 잠금 읽기하면 갭 락끼리 교착될 수 있어, 처음 상태 행을 먼저 만들고 그 행을 잠근다
    await tx
      .insert(userWordProgress)
      .ignore()
      .values({ userId, wordId, packId, ...nextProgress(null, null), lastStudiedAt: now });
    const [current] = await tx.select().from(userWordProgress).where(target).for('update');
    const next = nextProgress(current ?? null, { ...answer, sessionId: session.id });
    const review = nextReview(
      current ?? null,
      { ...answer, isReview: session.source === 'REVIEW' },
      kstDate(now),
    );
    await tx
      .update(userWordProgress)
      .set({
        memoryStatus: next.memoryStatus,
        correctStreak: next.correctStreak,
        lastCorrectSessionId: next.lastCorrectSessionId,
        totalCorrect: next.totalCorrect,
        totalWrong: next.totalWrong,
        ...review,
        lastStudiedAt: now,
      })
      .where(target);
  }
}
