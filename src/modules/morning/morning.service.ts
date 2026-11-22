import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, lt, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException, CommonErrors } from '../../common/errors/app-exception.js';
import {
  type CursorPage,
  type CursorQuery,
  decodeCursor,
  toCursorPage,
} from '../../common/pagination.js';
import { type Database, DB, type Transaction } from '../../infra/db/db.module.js';
import {
  type MorningSentenceRow,
  morningCompletions,
  morningKeywords,
  morningQuizzes,
  morningSentences,
  userStreaks,
} from '../../infra/db/schema/index.js';
import { PacksService } from '../packs/packs.service.js';
import { RankingService } from '../ranking/ranking.service.js';
import { streakView } from '../records/stats.js';
import { nextStreak } from '../study/study-result.js';
import { WordsService } from '../words/words.service.js';
import { XpService } from '../xp/xp.service.js';
import type {
  CompleteMorningQuiz,
  MorningListItem,
  MorningQuizResult,
  MorningSentence,
  SaveMorningWords,
  SaveMorningWordsResult,
} from './morning.schemas.js';
import { isCorrectAnswer, MORNING_XP, morningDate } from './morning-rules.js';

const DateCursor = z.object({ date: z.iso.date() });

export const MorningErrors = {
  notFound: () =>
    new AppException('MORNING_NOT_FOUND', '오늘의 문장을 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
};

@Injectable()
export class MorningService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly xp: XpService,
    private readonly ranking: RankingService,
    private readonly packs: PacksService,
    private readonly words: WordsService,
  ) {}

  /** 오늘 문장이 없으면 가장 최근 문장 (isFallback) */
  async today(user: AuthUser): Promise<MorningSentence> {
    const today = morningDate();
    const [row] = await this.db
      .select()
      .from(morningSentences)
      .where(this.visible(today))
      .orderBy(desc(morningSentences.publishDate))
      .limit(1);
    if (!row) throw MorningErrors.notFound();
    return this.view(user, row, row.publishDate !== today);
  }

  async byDate(user: AuthUser, date: string): Promise<MorningSentence> {
    return this.view(user, await this.find(date), false);
  }

  async list(user: AuthUser, query: CursorQuery): Promise<CursorPage<MorningListItem>> {
    const cursor = query.cursor ? decodeCursor(query.cursor, DateCursor) : null;
    const rows = await this.db
      .select({
        id: morningSentences.id,
        date: morningSentences.publishDate,
        sentence: morningSentences.sentence,
      })
      .from(morningSentences)
      .where(
        and(
          this.visible(morningDate()),
          cursor ? lt(morningSentences.publishDate, cursor.date) : undefined,
        ),
      )
      .orderBy(desc(morningSentences.publishDate))
      .limit(query.size + 1);
    const page = toCursorPage(rows, query.size, (last) => ({ date: last.date }));
    const done = await this.completedAmong(
      user.userId,
      page.items.map((row) => row.id),
    );
    return {
      items: page.items.map((row) => ({
        date: row.date,
        sentence: row.sentence,
        completed: done.has(row.id),
      })),
      nextCursor: page.nextCursor,
    };
  }

  /**
   * 모든 문항에 답해야 한다. 정답을 미리 내려주므로 XP는 정답 수와 상관없이
   * 오늘 문장을 처음 끝냈을 때 하루 한 번 준다. 지난 문장은 기록만 남긴다
   */
  async complete(
    user: AuthUser,
    date: string,
    body: CompleteMorningQuiz,
  ): Promise<MorningQuizResult> {
    const sentence = await this.find(date);
    const quizzes = await this.db
      .select()
      .from(morningQuizzes)
      .where(eq(morningQuizzes.sentenceId, sentence.id))
      .orderBy(asc(morningQuizzes.idx));
    const answers = new Map(body.answers.map((a) => [a.index, a.answer]));
    if (
      answers.size !== body.answers.length ||
      answers.size !== quizzes.length ||
      quizzes.some((quiz) => !answers.has(quiz.idx))
    ) {
      throw CommonErrors.invalidRequest({ field: 'answers' }, '모든 문항에 한 번씩 답해야 합니다.');
    }
    const results = quizzes.map((quiz) => ({
      index: quiz.idx,
      correct: isCorrectAnswer(quiz.answers, answers.get(quiz.idx) ?? ''),
    }));
    const correctCount = results.filter((r) => r.correct).length;

    const now = new Date();
    const today = morningDate(now);
    const isToday = date === today;
    const result = await this.db.transaction(async (tx) => {
      // 지난 문장이어도 사용자 행을 잠그고 오늘 XP 합계를 알려 준다
      const grant = await this.xp.grant(
        tx,
        user.userId,
        isToday ? [{ source: 'MORNING', refKey: date, amount: MORNING_XP }] : [],
        now,
      );
      await tx.insert(morningCompletions).ignore().values({
        userId: user.userId,
        sentenceId: sentence.id,
        correctCount,
        total: quizzes.length,
        xpGranted: grant.earned,
        completedAt: now,
      });
      const streak = isToday
        ? await this.updateStreak(tx, user.userId, today)
        : { current: await this.currentStreak(tx, user.userId, today), increased: false };
      return {
        correctCount,
        total: quizzes.length,
        results,
        xp: {
          earned: grant.earned,
          blockedReason: grant.capped ? ('DAILY_CAP' as const) : null,
          todayTotal: grant.todayTotal,
        },
        alreadyCompletedToday: isToday && grant.granted[0] === null,
        streak,
      };
    });
    await this.ranking.addXp(user.userId, result.xp.earned, now);
    return result;
  }

  /** 중복은 건너뛰고, 한도를 넘으면 하나도 넣지 않고 409 */
  async saveWords(
    user: AuthUser,
    date: string,
    body: SaveMorningWords,
  ): Promise<SaveMorningWordsResult> {
    const sentence = await this.find(date);
    const keywords = await this.keywordsOf(sentence.id);
    const wanted = body.keywordIndexes ? new Set(body.keywordIndexes) : null;
    if (wanted && [...wanted].some((index) => !keywords.some((k) => k.idx === index))) {
      throw CommonErrors.invalidRequest({ field: 'keywordIndexes' }, '없는 핵심 어휘입니다.');
    }
    const selected = wanted ? keywords.filter((k) => wanted.has(k.idx)) : keywords;
    const packId =
      body.packId ??
      (await this.packs.create(user, { name: body.newPackName ?? '', type: 'MINE' })).packId;
    const result = await this.words.add(
      user,
      packId,
      {
        words: selected.map((k) => ({ english: k.english, meanings: k.meanings })),
        duplicatePolicy: 'SKIP',
      },
      { rejectOverLimit: true },
    );
    return { packId, saved: result.added, skipped: result.skipped };
  }

  /** 홈 카드. 게시된 문장이 하나도 없으면 null */
  async card(user: AuthUser) {
    const view = await this.today(user).catch((error: unknown) => {
      if (error instanceof AppException && error.code === 'MORNING_NOT_FOUND') return null;
      throw error;
    });
    if (!view) return null;
    return {
      date: view.date,
      sentence: view.sentence,
      translation: view.translation,
      keywords: view.keywords.map((k) => k.english),
      completed: view.completed,
      isFallback: view.isFallback,
    };
  }

  private visible(today: string) {
    return and(eq(morningSentences.status, 'PUBLISHED'), lte(morningSentences.publishDate, today));
  }

  /** 게시 전·미래 날짜는 없는 것과 같다 */
  private async find(date: string): Promise<MorningSentenceRow> {
    const [row] = await this.db
      .select()
      .from(morningSentences)
      .where(and(eq(morningSentences.publishDate, date), this.visible(morningDate())));
    if (!row) throw MorningErrors.notFound();
    return row;
  }

  private async view(
    user: AuthUser,
    row: MorningSentenceRow,
    isFallback: boolean,
  ): Promise<MorningSentence> {
    const [keywords, quizzes, done, streak] = await Promise.all([
      this.keywordsOf(row.id),
      this.db
        .select()
        .from(morningQuizzes)
        .where(eq(morningQuizzes.sentenceId, row.id))
        .orderBy(asc(morningQuizzes.idx)),
      this.completedAmong(user.userId, [row.id]),
      this.currentStreak(this.db, user.userId, morningDate()),
    ]);
    return {
      date: row.publishDate,
      isFallback,
      sentence: row.sentence,
      translation: row.translation,
      keywords: keywords.map((k) => ({
        index: k.idx,
        english: k.english,
        meanings: k.meanings,
        example: k.example,
        highlight: { start: k.highlightStart, end: k.highlightEnd },
      })),
      quizzes: quizzes.map((q) => ({
        index: q.idx,
        type: q.type,
        question: q.question,
        choices: q.choices,
        answers: q.answers,
        explanation: q.explanation,
      })),
      completed: done.has(row.id),
      streak: { current: streak },
    };
  }

  private keywordsOf(sentenceId: string) {
    return this.db
      .select()
      .from(morningKeywords)
      .where(eq(morningKeywords.sentenceId, sentenceId))
      .orderBy(asc(morningKeywords.idx));
  }

  private async completedAmong(userId: string, sentenceIds: string[]): Promise<Set<string>> {
    if (sentenceIds.length === 0) return new Set();
    const rows = await this.db
      .select({ sentenceId: morningCompletions.sentenceId })
      .from(morningCompletions)
      .where(
        and(
          eq(morningCompletions.userId, userId),
          inArray(morningCompletions.sentenceId, sentenceIds),
        ),
      );
    return new Set(rows.map((r) => r.sentenceId));
  }

  private streakTarget(userId: string) {
    return and(eq(userStreaks.userId, userId), eq(userStreaks.kind, 'MORNING'));
  }

  private async currentStreak(
    executor: Database | Transaction,
    userId: string,
    today: string,
  ): Promise<number> {
    const [state] = await executor.select().from(userStreaks).where(this.streakTarget(userId));
    return streakView(state ?? null, today).current;
  }

  /** XP 지급에서 사용자 행을 잠갔으므로 같은 사용자의 갱신은 차례로 처리된다 */
  private async updateStreak(tx: Transaction, userId: string, today: string) {
    const [state] = await tx.select().from(userStreaks).where(this.streakTarget(userId));
    const next = nextStreak(state ?? null, today);
    if (next.increased) {
      await tx
        .insert(userStreaks)
        .values({
          userId,
          kind: 'MORNING',
          current: next.current,
          best: next.best,
          lastDate: next.lastDate,
        })
        .onDuplicateKeyUpdate({
          set: { current: next.current, best: next.best, lastDate: next.lastDate },
        });
    }
    return { current: next.current, increased: next.increased };
  }
}
