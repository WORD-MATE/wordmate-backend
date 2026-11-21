import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException, CommonErrors } from '../../common/errors/app-exception.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { practiceSessions, words } from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { buildBattleQuestions } from '../battles/battle-rules.js';
import { MIN_BATTLE_WORDS, RoomErrors } from '../battles/rooms.service.js';
import { PacksService } from '../packs/packs.service.js';
import { recordWrongWords } from '../wrong-notes/wrong-note-writer.js';
import type {
  CompletePractice,
  Practice,
  PracticeResult,
  StartPractice,
} from './practice.schemas.js';
import { scorePractice } from './practice-scoring.js';

export const PracticeErrors = {
  notFound: () =>
    new AppException('BATTLE_PRACTICE_NOT_FOUND', '연습을 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
  alreadyCompleted: () =>
    new AppException(
      'BATTLE_PRACTICE_ALREADY_COMPLETED',
      '이미 끝낸 연습입니다.',
      HttpStatus.CONFLICT,
    ),
};

@Injectable()
export class PracticeService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly packs: PacksService,
  ) {}

  /** 대결과 같은 방식으로 문항을 만들어 정답과 함께 내려준다 (XP 없음) */
  async start(user: AuthUser, body: StartPractice): Promise<Practice> {
    const pack = await this.packs.findVisible(user, body.packId);
    if (pack.wordCount < MIN_BATTLE_WORDS) throw RoomErrors.packTooFewWords();
    const packWords = await this.db
      .select({
        id: words.id,
        packId: words.packId,
        english: words.english,
        meanings: words.meanings,
        derivatives: words.derivatives,
      })
      .from(words)
      .where(and(eq(words.packId, pack.id), isNull(words.deletedAt)))
      .orderBy(asc(words.id));
    const direction = body.questionType.startsWith('EN_TO_KO') ? 'EN_TO_KO' : 'KO_TO_EN';
    const built = buildBattleQuestions(packWords, body.questionCount, direction);
    if (!built) throw RoomErrors.packTooFewWords();
    const questions = built.map((q) => ({
      index: q.idx,
      wordId: q.wordId,
      prompt: q.prompt,
      choices: q.choices,
      answerIndex: q.answerIndex,
    }));
    const practiceId = newId();
    await this.db.insert(practiceSessions).values({
      id: practiceId,
      userId: user.userId,
      packId: pack.id,
      questionType: body.questionType,
      questionCount: body.questionCount,
      timeLimitSec: body.timeLimitSec,
      questions,
    });
    return {
      practiceId,
      questions: questions.map(({ wordId: _wordId, ...question }) => question),
    };
  }

  /** 한 번만 끝낼 수 있다. 틀렸거나 답하지 않은 단어는 오답노트(출처 BATTLE)로 */
  async complete(
    user: AuthUser,
    practiceId: string,
    body: CompletePractice,
  ): Promise<PracticeResult> {
    return this.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(practiceSessions)
        .where(and(eq(practiceSessions.id, practiceId), eq(practiceSessions.userId, user.userId)))
        .for('update');
      if (!session) throw PracticeErrors.notFound();
      if (session.completedAt) throw PracticeErrors.alreadyCompleted();
      if (body.answers.some((answer) => answer.index >= session.questionCount)) {
        throw CommonErrors.invalidRequest({ field: 'answers' }, '없는 문항입니다.');
      }
      const now = new Date();
      const result = scorePractice(session.questions, body.answers, session.timeLimitSec * 1000);
      await tx
        .update(practiceSessions)
        .set({ score: result.score, correctCount: result.correctCount, completedAt: now })
        .where(eq(practiceSessions.id, practiceId));
      await recordWrongWords(
        tx,
        result.wrongWordIds.map((wordId) => ({
          userId: user.userId,
          wordId,
          packId: session.packId,
          questionType: session.questionType,
        })),
        'BATTLE',
        now,
      );
      return {
        score: result.score,
        correctCount: result.correctCount,
        total: session.questionCount,
      };
    });
  }
}
