import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException, CommonErrors } from '../../common/errors/app-exception.js';
import { type Database, DB, type Transaction } from '../../infra/db/db.module.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import {
  packs,
  type StudySessionRow,
  studySessionQuestions,
  studySessions,
  wordFavorites,
  words,
} from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { PacksService } from '../packs/packs.service.js';
import { visibleWords } from '../words/word-common.js';
import { type BuiltQuestion, buildQuestion, type QuizWord, shuffled } from './question-builder.js';
import type { CurrentStudy, StartStudy, StudySession } from './study.schemas.js';

export const SESSION_TTL_DAYS = 7;
const ACTIVE_INDEX = 'study_sessions_active_uq';
const INSERT_CHUNK = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

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
  closed: () =>
    new AppException('STUDY_SESSION_CLOSED', '이미 끝난 학습입니다.', HttpStatus.CONFLICT),
  sourceNotSupported: () =>
    CommonErrors.invalidRequest({ field: 'source' }, '아직 지원하지 않는 학습 방식입니다.'),
};

const quizWordColumns = {
  id: words.id,
  packId: words.packId,
  english: words.english,
  meanings: words.meanings,
  derivatives: words.derivatives,
};

const isLive = (session: StudySessionRow, now = new Date()) =>
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
    const questions = await this.buildQuestions(body, selected, candidates);

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
          total: questions.length,
          expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * DAY_MS),
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
      // 답안 제출(#45)이 생기면 채운다
      answers: [],
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
      default:
        // WRONG_NOTE·RECORD_WRONG·REVIEW는 오답노트·기록·복습 작업에서 연결한다
        throw StudyErrors.sourceNotSupported();
    }
  }

  /**
   * 4지선다 오답 보기는 그 단어의 단어팩에서 고르고, 모자라면 이번 학습의 다른 단어에서 채운다
   * (즐겨찾기처럼 여러 팩에 걸친 학습에서 팩 단어가 4개 미만인 경우)
   */
  private async buildQuestions(
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
        const packWords = await this.db
          .select(quizWordColumns)
          .from(words)
          .where(and(inArray(words.packId, packIds), isNull(words.deletedAt)));
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
