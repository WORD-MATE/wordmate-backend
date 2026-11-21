import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException, CommonErrors } from '../../common/errors/app-exception.js';
import { kstDate } from '../../common/time/kst.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import { challengeAttempts, dailyChallenges, packs, words } from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { RankingService } from '../ranking/ranking.service.js';
import type { QuizWord } from '../study/question-builder.js';
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

/** 문제를 만들 후보 단어 수 (보기를 만들 수 없는 단어를 건너뛰어도 모자라지 않게) */
const CANDIDATE_WORDS = 50;

export const ChallengeErrors = {
  alreadyDone: () =>
    new AppException(
      'CHALLENGE_ALREADY_DONE',
      '오늘의 챌린지는 이미 했습니다.',
      HttpStatus.CONFLICT,
    ),
  inProgress: (attemptId: string) =>
    new AppException('CHALLENGE_IN_PROGRESS', '진행 중인 챌린지가 있습니다.', HttpStatus.CONFLICT, {
      attemptId,
    }),
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
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly xp: XpService,
    private readonly ranking: RankingService,
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
      throw ChallengeErrors.inProgress(existing.id);
    }
    return {
      attemptId,
      questions: challenge.questions.map(({ index, prompt, choices }) => ({
        index,
        prompt,
        choices,
      })),
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
      const scored = scoreChallenge(
        challenge.questions,
        body.answers,
        challenge.timeLimitSec * 1000,
        now <= deadline,
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
      const blockedReason = grant.capped ? ('DAILY_CAP' as const) : null;
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
    return result;
  }

  /** 그날 문제가 없으면 만든다. 여러 서버가 동시에 만들어도 날짜가 키라 하나만 남는다 */
  async ensure(date: string) {
    const existing = await this.find(date);
    if (existing) return existing;
    const questions = await this.generate();
    if (questions) {
      await this.db
        .insert(dailyChallenges)
        .ignore()
        .values({ date, ...CHALLENGE_SETTINGS, questions });
    }
    const created = await this.find(date);
    if (!created) throw ChallengeErrors.unavailable();
    return created;
  }

  private async find(date: string) {
    const [challenge] = await this.db
      .select()
      .from(dailyChallenges)
      .where(eq(dailyChallenges.date, date));
    return challenge ?? null;
  }

  /** 기본 단어팩 전체에서 무작위로 고르고, 오답 보기는 그 단어의 팩에서 고른다 */
  private async generate() {
    const columns = {
      id: words.id,
      packId: words.packId,
      english: words.english,
      meanings: words.meanings,
      derivatives: words.derivatives,
    };
    const candidates: QuizWord[] = await this.db
      .select(columns)
      .from(words)
      .innerJoin(packs, eq(packs.id, words.packId))
      .where(and(eq(packs.type, 'DEFAULT'), isNull(packs.deletedAt), isNull(words.deletedAt)))
      .orderBy(sql`RAND()`)
      .limit(CANDIDATE_WORDS);
    if (candidates.length === 0) return null;
    const packIds = [...new Set(candidates.map((word) => word.packId))];
    const pool = await this.db
      .select(columns)
      .from(words)
      .where(and(inArray(words.packId, packIds), isNull(words.deletedAt)));
    const byPack = new Map<string, QuizWord[]>();
    for (const word of pool) byPack.set(word.packId, [...(byPack.get(word.packId) ?? []), word]);
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
