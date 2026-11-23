import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException, CommonErrors } from '../../common/errors/app-exception.js';
import { kstDate } from '../../common/time/kst.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import {
  type ChallengeQuestion,
  challengeAttempts,
  type DailyChallenge,
  dailyChallenges,
  packs,
  words,
} from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { BadgesService } from '../badges/badges.service.js';
import { RankingService } from '../ranking/ranking.service.js';
import { CHOICE_COUNT, type QuizWord, shuffled } from '../study/question-builder.js';
import { XpService } from '../xp/xp.service.js';
import {
  CHALLENGE_SETTINGS,
  CHALLENGE_XP_PER_CORRECT,
  challengeDeadline,
  pickChallengeQuestions,
  scoreChallenge,
} from './challenge-rules.js';
import type {
  ChallengeAttempt,
  ChallengeResult,
  ChallengeToday,
  CompleteChallenge,
} from './challenges.schemas.js';

/** 문제를 고를 기본 단어팩 수 */
const SOURCE_PACKS = 5;
/** 문제를 만들지 못했을 때 다시 시도하지 않는 시간 */
const FAILURE_BACKOFF_MS = 60 * 1000;

export const ChallengeErrors = {
  alreadyDone: () =>
    new AppException(
      'CHALLENGE_ALREADY_DONE',
      '오늘의 챌린지는 이미 했습니다.',
      HttpStatus.CONFLICT,
    ),
  /** 시작 응답을 못 받은 경우에도 이어서 풀 수 있게 문항을 같이 돌려준다 */
  inProgress: (attempt: ChallengeAttempt) =>
    new AppException(
      'CHALLENGE_IN_PROGRESS',
      '진행 중인 챌린지가 있습니다.',
      HttpStatus.CONFLICT,
      attempt,
    ),
  attemptNotFound: () =>
    new AppException(
      'CHALLENGE_ATTEMPT_NOT_FOUND',
      '챌린지 기록을 찾을 수 없습니다.',
      HttpStatus.NOT_FOUND,
    ),
  unavailable: () =>
    new AppException(
      'CHALLENGE_UNAVAILABLE',
      '오늘의 챌린지를 준비하지 못했습니다.',
      HttpStatus.SERVICE_UNAVAILABLE,
    ),
};

@Injectable()
export class ChallengesService {
  // 서버마다 따로 둔다. 여러 서버가 동시에 만들어도 날짜 기본 키와 INSERT IGNORE가 하나만 남긴다
  private readonly generating = new Map<string, Promise<DailyChallenge | null>>();
  private readonly failedUntil = new Map<string, number>();

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly xp: XpService,
    private readonly ranking: RankingService,
    private readonly badges: BadgesService,
  ) {}

  async today(user: AuthUser): Promise<ChallengeToday> {
    const date = kstDate();
    const challenge = await this.ensure(date);
    const [attempt] = await this.db
      .select()
      .from(challengeAttempts)
      .where(and(eq(challengeAttempts.userId, user.userId), eq(challengeAttempts.date, date)));
    return {
      date,
      questionCount: challenge.questionCount,
      timeLimitSec: challenge.timeLimitSec,
      participated: Boolean(attempt),
      myResult:
        attempt?.completedAt && attempt.score !== null && attempt.correctCount !== null
          ? { score: attempt.score, correctCount: attempt.correctCount, xp: attempt.xpEarned ?? 0 }
          : null,
    };
  }

  /** 하루 한 번. 정답은 내려주지 않는다 (시간은 시작 시각부터 서버가 잰다) */
  async start(user: AuthUser): Promise<ChallengeAttempt> {
    const date = kstDate();
    const challenge = await this.ensure(date);
    const attemptId = newId();
    try {
      await this.db
        .insert(challengeAttempts)
        .values({ id: attemptId, userId: user.userId, date, startedAt: new Date() });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      const [existing] = await this.db
        .select({ id: challengeAttempts.id, completedAt: challengeAttempts.completedAt })
        .from(challengeAttempts)
        .where(and(eq(challengeAttempts.userId, user.userId), eq(challengeAttempts.date, date)));
      if (!existing || existing.completedAt) throw ChallengeErrors.alreadyDone();
      throw ChallengeErrors.inProgress(this.attemptOf(existing.id, challenge.questions));
    }
    return this.attemptOf(attemptId, challenge.questions);
  }

  private attemptOf(attemptId: string, questions: ChallengeQuestion[]): ChallengeAttempt {
    return {
      attemptId,
      questions: questions.map(({ index, prompt, choices }) => ({ index, prompt, choices })),
    };
  }

  /**
   * 한 번만 끝낼 수 있다. 시작 시각부터 모든 문항을 제한 시간까지 쓴 시간(+ 여유)이 지나 끝내면 모두 미응답.
   * XP는 정답 1개당 3 (하루 500 상한 포함)
   */
  async complete(
    user: AuthUser,
    attemptId: string,
    body: CompleteChallenge,
  ): Promise<ChallengeResult> {
    const now = new Date();
    const result = await this.db.transaction(async (tx) => {
      const [attempt] = await tx
        .select()
        .from(challengeAttempts)
        .where(and(eq(challengeAttempts.id, attemptId), eq(challengeAttempts.userId, user.userId)))
        .for('update');
      if (!attempt) throw ChallengeErrors.attemptNotFound();
      if (attempt.completedAt) throw ChallengeErrors.alreadyDone();
      const [challenge] = await tx
        .select()
        .from(dailyChallenges)
        .where(eq(dailyChallenges.date, attempt.date));
      if (!challenge) throw ChallengeErrors.attemptNotFound();
      if (body.answers.some((answer) => answer.index >= challenge.questionCount)) {
        throw CommonErrors.invalidRequest({ field: 'answers' }, '없는 문항입니다.');
      }
      const deadline = challengeDeadline(
        attempt.startedAt,
        challenge.questionCount,
        challenge.timeLimitSec,
      );
      const inTime = now <= deadline;
      const scored = scoreChallenge(
        challenge.questions,
        body.answers,
        challenge.timeLimitSec * 1000,
        inTime,
      );
      const grant = await this.xp.grant(
        tx,
        user.userId,
        [
          {
            source: 'CHALLENGE',
            refKey: `challenge:${attempt.date}`,
            amount: scored.correctCount * CHALLENGE_XP_PER_CORRECT,
          },
        ],
        now,
      );
      const blockedReason = !inTime
        ? ('NOT_COMPLETED' as const)
        : grant.capped
          ? ('DAILY_CAP' as const)
          : null;
      await tx
        .update(challengeAttempts)
        .set({
          completedAt: now,
          score: scored.score,
          correctCount: scored.correctCount,
          answers: body.answers,
          xpEarned: grant.earned,
          xpBlockedReason: blockedReason,
        })
        .where(eq(challengeAttempts.id, attemptId));
      return {
        score: scored.score,
        correctCount: scored.correctCount,
        total: challenge.questionCount,
        results: scored.results,
        xp: { earned: grant.earned, blockedReason, todayTotal: grant.todayTotal },
      };
    });
    await this.ranking.addXp(user.userId, result.xp.earned, now);
    await this.badges.evaluate(user.userId);
    return result;
  }

  /**
   * 그날 문제가 없으면 만든다. 여러 서버가 동시에 만들어도 날짜가 키라 하나만 남는다.
   * 자정에 요청이 몰려도 한 서버 안에서는 한 번만 만들고, 만들지 못했으면 잠시 다시 시도하지 않는다
   */
  async ensure(date: string) {
    const existing = await this.find(date);
    if (existing) return existing;
    if ((this.failedUntil.get(date) ?? 0) > Date.now()) throw ChallengeErrors.unavailable();
    let running = this.generating.get(date);
    if (!running) {
      running = this.create(date).finally(() => this.generating.delete(date));
      this.generating.set(date, running);
    }
    const created = await running;
    if (!created) {
      this.failedUntil.set(date, Date.now() + FAILURE_BACKOFF_MS);
      throw ChallengeErrors.unavailable();
    }
    return created;
  }

  private async create(date: string) {
    const questions = await this.generate();
    if (questions) {
      await this.db
        .insert(dailyChallenges)
        .ignore()
        .values({ date, ...CHALLENGE_SETTINGS, questions });
    }
    return this.find(date);
  }

  private async find(date: string) {
    const [challenge] = await this.db
      .select()
      .from(dailyChallenges)
      .where(eq(dailyChallenges.date, date));
    return challenge ?? null;
  }

  /**
   * 기본 단어팩 몇 개를 무작위로 골라 그 팩들의 단어를 섞어 낸다. 오답 보기는 그 단어의 팩에서 고른다
   * (단어 전체를 섞지 않고 팩 몇 개만 읽어 부담을 줄인다)
   */
  private async generate() {
    const chosen = await this.db
      .select({ id: packs.id })
      .from(packs)
      .where(
        and(eq(packs.type, 'DEFAULT'), isNull(packs.deletedAt), gte(packs.wordCount, CHOICE_COUNT)),
      )
      .orderBy(sql`RAND()`)
      .limit(SOURCE_PACKS);
    if (chosen.length === 0) return null;
    const pool: QuizWord[] = await this.db
      .select({
        id: words.id,
        packId: words.packId,
        english: words.english,
        meanings: words.meanings,
        derivatives: words.derivatives,
      })
      .from(words)
      .where(
        and(
          inArray(
            words.packId,
            chosen.map((pack) => pack.id),
          ),
          isNull(words.deletedAt),
        ),
      );
    const byPack = new Map<string, QuizWord[]>();
    for (const word of pool) byPack.set(word.packId, [...(byPack.get(word.packId) ?? []), word]);
    const candidates = shuffled(pool);
    const direction = CHALLENGE_SETTINGS.questionType.startsWith('EN_TO_KO')
      ? 'EN_TO_KO'
      : 'KO_TO_EN';
    return pickChallengeQuestions(
      candidates,
      (packId) => byPack.get(packId) ?? [],
      CHALLENGE_SETTINGS.questionCount,
      direction,
    );
  }
}
