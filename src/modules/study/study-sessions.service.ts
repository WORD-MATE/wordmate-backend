import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException, CommonErrors } from '../../common/errors/app-exception.js';
import { kstDate } from '../../common/time/kst.js';
import { type Database, DB, type Transaction } from '../../infra/db/db.module.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import {
  packs,
  type StudySessionRow,
  studyAnswers,
  studyRecordItems,
  studyRecords,
  studySessionQuestions,
  studySessions,
  userWordProgress,
  wordFavorites,
  words,
  wrongNotes,
} from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { PacksService } from '../packs/packs.service.js';
import { RecordErrors } from '../records/records.service.js';
import { visibleWords } from '../words/word-common.js';
import { DAILY_REVIEW_LIMIT } from './grading.js';
import { type BuiltQuestion, buildQuestion, type QuizWord, shuffled } from './question-builder.js';
import type { CurrentStudy, ReviewSummary, StartStudy, StudySession } from './study.schemas.js';

export const SESSION_TTL_DAYS = 7;
export const sessionExpiry = (from = new Date()) =>
  new Date(from.getTime() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
const ACTIVE_INDEX = 'study_sessions_active_uq';
const INSERT_CHUNK = 500;

export const StudyErrors = {
  empty: () => new AppException('STUDY_EMPTY', '학습할 단어가 없습니다.', HttpStatus.BAD_REQUEST),
  tooFewWords: () =>
    new AppException(
      'STUDY_TOO_FEW_WORDS',
      '4지선다는 보기가 서로 다른 단어가 4개 이상 있어야 합니다.',
      HttpStatus.BAD_REQUEST,
    ),
  exists: (sessionId: string) =>
    new AppException('STUDY_SESSION_EXISTS', '이어할 학습이 있습니다.', HttpStatus.CONFLICT, {
      sessionId,
    }),
  notFound: () =>
    new AppException('STUDY_SESSION_NOT_FOUND', '학습을 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
  alreadySubmitted: () =>
    new AppException(
      'STUDY_ANSWER_ALREADY_SUBMITTED',
      '이미 답을 낸 문항입니다.',
      HttpStatus.CONFLICT,
    ),
  closed: () =>
    new AppException('STUDY_SESSION_CLOSED', '이미 끝난 학습입니다.', HttpStatus.CONFLICT),
};

const quizWordColumns = {
  id: words.id,
  packId: words.packId,
  english: words.english,
  meanings: words.meanings,
  derivatives: words.derivatives,
};

export const isLive = (session: StudySessionRow, now = new Date()) =>
  session.status !== 'ABANDONED' && !(session.status === 'IN_PROGRESS' && session.expiresAt <= now);

@Injectable()
export class StudySessionsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly packs: PacksService,
  ) {}

  async start(user: AuthUser, body: StartStudy): Promise<StudySession> {
    const packId =
      body.source === 'PACK'
        ? (await this.packs.findVisible(user, body.packId as string)).id
        : null;
    const candidates = await this.candidates(user, body, packId);
    if (candidates.length === 0) throw StudyErrors.empty();

    const ordered = body.shuffle ? shuffled(candidates) : candidates;
    const selected = ordered.slice(0, body.questionCount ?? ordered.length);
    const questions = await this.buildQuestions(user.userId, body, selected, candidates);

    const sessionId = newId();
    try {
      await this.db.transaction(async (tx) => {
        await this.releaseActive(tx, user.userId, body.source, packId, body.force);
        await tx.insert(studySessions).values({
          id: sessionId,
          userId: user.userId,
          source: body.source,
          packId,
          mode: body.mode,
          direction: body.direction,
          shuffle: body.shuffle,
          coversPack: body.source === 'PACK' && selected.length === candidates.length,
          total: questions.length,
          expiresAt: sessionExpiry(),
        });
        for (let i = 0; i < questions.length; i += INSERT_CHUNK) {
          await tx
            .insert(studySessionQuestions)
            .values(questions.slice(i, i + INSERT_CHUNK).map((q) => ({ ...q, sessionId })));
        }
      });
    } catch (error) {
      // 같은 요청이 동시에 두 번 들어와 다른 요청이 먼저 만든 경우
      if (isDuplicateKeyError(error, ACTIVE_INDEX)) {
        const active = await this.findActive(this.db, user.userId, body.source, packId);
        if (active) throw StudyErrors.exists(active.id);
      }
      throw error;
    }
    return this.get(user, sessionId);
  }

  async get(user: AuthUser, sessionId: string): Promise<StudySession> {
    const session = await this.findOwned(user, sessionId);
    const questions = await this.db
      .select()
      .from(studySessionQuestions)
      .where(eq(studySessionQuestions.sessionId, session.id))
      .orderBy(asc(studySessionQuestions.idx));
    const answers = await this.db
      .select()
      .from(studyAnswers)
      .where(eq(studyAnswers.sessionId, session.id))
      .orderBy(asc(studyAnswers.idx));
    return {
      sessionId: session.id,
      source: session.source,
      pack: await this.packOf(session.packId),
      mode: session.mode,
      direction: session.direction,
      status: session.status,
      startedAt: session.createdAt.toISOString(),
      questions: questions.map((q) => ({
        index: q.idx,
        wordId: q.wordId,
        prompt: q.prompt,
        derivatives: q.derivatives,
        choices: q.choices,
        answerIndex: q.answerIndex,
        card: q.card,
      })),
      answers: answers.map((a) => ({
        index: a.idx,
        correct: a.correct,
        known: a.known,
        userAnswer: a.typedAnswer,
      })),
    };
  }

  /** 가장 최근에 이어할 학습 하나 */
  async current(user: AuthUser): Promise<CurrentStudy> {
    const [session] = await this.db
      .select()
      .from(studySessions)
      .where(
        and(
          eq(studySessions.userId, user.userId),
          eq(studySessions.status, 'IN_PROGRESS'),
          gt(studySessions.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(studySessions.updatedAt), desc(studySessions.id))
      .limit(1);
    if (!session) return null;
    return {
      sessionId: session.id,
      source: session.source,
      pack: await this.packOf(session.packId),
      mode: session.mode,
      answered: session.answeredCount,
      total: session.total,
      updatedAt: session.updatedAt.toISOString(),
    };
  }

  /** 기록을 남기지 않고 버린다 (ABANDONED) */
  async remove(user: AuthUser, sessionId: string): Promise<void> {
    const session = await this.findOwned(user, sessionId);
    if (session.status !== 'IN_PROGRESS') throw StudyErrors.closed();
    await this.db
      .update(studySessions)
      .set({ status: 'ABANDONED' })
      .where(and(eq(studySessions.id, session.id), eq(studySessions.status, 'IN_PROGRESS')));
  }

  private async findOwned(user: AuthUser, sessionId: string): Promise<StudySessionRow> {
    const [session] = await this.db
      .select()
      .from(studySessions)
      .where(eq(studySessions.id, sessionId));
    if (!session || !isLive(session)) throw StudyErrors.notFound();
    if (session.userId !== user.userId) throw CommonErrors.forbidden();
    return session;
  }

  private async packOf(packId: string | null) {
    if (!packId) return null;
    const [pack] = await this.db
      .select({ packId: packs.id, name: packs.name })
      .from(packs)
      .where(eq(packs.id, packId));
    return pack ?? null;
  }

  private async candidates(
    user: AuthUser,
    body: StartStudy,
    packId: string | null,
  ): Promise<QuizWord[]> {
    switch (body.source) {
      case 'PACK':
        return this.db
          .select(quizWordColumns)
          .from(words)
          .where(and(eq(words.packId, packId as string), isNull(words.deletedAt)))
          .orderBy(asc(words.id));
      case 'FAVORITE':
        return this.db
          .select(quizWordColumns)
          .from(wordFavorites)
          .innerJoin(words, eq(words.id, wordFavorites.wordId))
          .innerJoin(packs, eq(packs.id, words.packId))
          .where(
            and(
              eq(wordFavorites.userId, user.userId),
              visibleWords(user.userId),
              body.wordIds ? inArray(words.id, body.wordIds) : undefined,
            ),
          )
          .orderBy(asc(wordFavorites.createdAt), asc(words.id));
      case 'WRONG_NOTE': {
        // 한 단어에 문제 유형별 오답이 여러 개일 수 있어 최근에 틀린 순으로 한 번씩만 낸다.
        // 팩이 삭제돼도 단어가 남아 있으면 복습할 수 있다
        const rows = await this.db
          .select(quizWordColumns)
          .from(wrongNotes)
          .innerJoin(words, eq(words.id, wrongNotes.wordId))
          .where(
            and(
              eq(wrongNotes.userId, user.userId),
              eq(wrongNotes.status, 'ACTIVE'),
              isNull(words.deletedAt),
              body.wordIds ? inArray(words.id, body.wordIds) : undefined,
            ),
          )
          .orderBy(desc(wrongNotes.lastWrongAt), asc(words.id));
        return [...new Map(rows.map((row) => [row.id, row])).values()];
      }
      case 'RECORD_WRONG': {
        const [record] = await this.db
          .select({ userId: studyRecords.userId })
          .from(studyRecords)
          .where(eq(studyRecords.id, body.recordId as string));
        if (!record) throw RecordErrors.notFound();
        if (record.userId !== user.userId) throw CommonErrors.forbidden();
        // 4지선다·직접 입력은 틀린 것, 플래시카드는 "몰라요"
        const rows = await this.db
          .select(quizWordColumns)
          .from(studyRecordItems)
          .innerJoin(words, eq(words.id, studyRecordItems.wordId))
          .where(
            and(
              eq(studyRecordItems.recordId, body.recordId as string),
              or(eq(studyRecordItems.correct, false), eq(studyRecordItems.known, false)),
              isNull(words.deletedAt),
            ),
          )
          .orderBy(asc(studyRecordItems.idx));
        return [...new Map(rows.map((row) => [row.id, row])).values()];
      }
      case 'REVIEW':
        return this.db
          .select(quizWordColumns)
          .from(userWordProgress)
          .innerJoin(words, eq(words.id, userWordProgress.wordId))
          .innerJoin(packs, eq(packs.id, words.packId))
          .where(this.dueForReview(user.userId))
          .orderBy(asc(userWordProgress.nextReviewOn), asc(words.id))
          .limit(DAILY_REVIEW_LIMIT);
    }
  }

  /** 오늘 복습할 단어 수(최대 DAILY_REVIEW_LIMIT)와 오늘 복습한 단어 수 */
  async reviewSummary(user: AuthUser): Promise<ReviewSummary> {
    const [due] = await this.db
      .select({ total: count() })
      .from(userWordProgress)
      .innerJoin(words, eq(words.id, userWordProgress.wordId))
      .innerJoin(packs, eq(packs.id, words.packId))
      .where(this.dueForReview(user.userId));
    const [done] = await this.db
      .select({ total: count() })
      .from(userWordProgress)
      .where(
        and(
          eq(userWordProgress.userId, user.userId),
          eq(userWordProgress.lastReviewedOn, kstDate()),
        ),
      );
    return {
      dueCount: Math.min(due?.total ?? 0, DAILY_REVIEW_LIMIT),
      completedToday: done?.total ?? 0,
    };
  }

  /** 복습일이 오늘(KST) 이전인 단어. 내가 지운 팩·단어는 복습하지 않는다 */
  private dueForReview(userId: string) {
    return and(
      eq(userWordProgress.userId, userId),
      lte(userWordProgress.nextReviewOn, kstDate()),
      visibleWords(userId),
    );
  }

  /**
   * 4지선다 오답 보기는 그 단어의 단어팩에서 고르고, 모자라면 이번 학습의 다른 단어에서 채운다
   * (즐겨찾기처럼 여러 팩에 걸친 학습에서 팩 단어가 4개 미만인 경우)
   */
  private async buildQuestions(
    userId: string,
    body: StartStudy,
    selected: QuizWord[],
    candidates: QuizWord[],
  ): Promise<BuiltQuestion[]> {
    const poolsByPack = new Map<string, QuizWord[]>();
    if (body.mode === 'CHOICE') {
      if (body.source === 'PACK') {
        poolsByPack.set(candidates[0]?.packId as string, candidates);
      } else {
        const packIds = [...new Set(selected.map((word) => word.packId))];
        // 대결에서 틀린 남의 비공개 팩 단어는 보기로 쓰지 않는다 (그 팩의 다른 단어가 드러난다)
        const packWords = await this.db
          .select(quizWordColumns)
          .from(words)
          .innerJoin(packs, eq(packs.id, words.packId))
          .where(
            and(
              inArray(words.packId, packIds),
              isNull(words.deletedAt),
              or(eq(packs.type, 'DEFAULT'), eq(packs.ownerUserId, userId)),
            ),
          );
        for (const word of packWords) {
          const pool = poolsByPack.get(word.packId) ?? [];
          pool.push(word);
          poolsByPack.set(word.packId, pool);
        }
      }
    }

    return selected.map((word, idx) => {
      const question = buildQuestion(word, idx, body.mode, body.direction, [
        poolsByPack.get(word.packId) ?? [],
        candidates,
      ]);
      if (!question) throw StudyErrors.tooFewWords();
      return question;
    });
  }

  /**
   * 같은 팩(팩이 없으면 같은 소스)에 이어할 학습이 있으면 409. 만료됐거나 force면 버린다.
   * 잠금 읽기(FOR UPDATE)를 쓰면 동시에 시작할 때 갭 락끼리 교착되므로 쓰지 않고, 경쟁은 active_key 유니크 인덱스로 막는다
   */
  private async releaseActive(
    tx: Transaction,
    userId: string,
    source: StartStudy['source'],
    packId: string | null,
    force: boolean,
  ): Promise<void> {
    const active = await this.findActive(tx, userId, source, packId);
    if (!active) return;
    if (active.expiresAt > new Date() && !force) throw StudyErrors.exists(active.id);
    await tx
      .update(studySessions)
      .set({ status: 'ABANDONED' })
      .where(eq(studySessions.id, active.id));
  }

  private async findActive(
    executor: Database | Transaction,
    userId: string,
    source: StartStudy['source'],
    packId: string | null,
  ) {
    const [row] = await executor
      .select({ id: studySessions.id, expiresAt: studySessions.expiresAt })
      .from(studySessions)
      .where(
        and(
          eq(studySessions.userId, userId),
          eq(studySessions.status, 'IN_PROGRESS'),
          packId
            ? eq(studySessions.packId, packId)
            : and(isNull(studySessions.packId), eq(studySessions.source, source)),
        ),
      );
    return row ?? null;
  }
}
