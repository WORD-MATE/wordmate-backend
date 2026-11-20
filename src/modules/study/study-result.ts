import type { QuizMode, StudyEndReason, StudySource, XpBlockReason } from '../../common/enums.js';

export const PACK_COMPLETE_XP = 10;

type AnswerLike = { correct: boolean | null; known: boolean | null; counted: boolean };

export type StudyCounts = {
  correctCount: number;
  wrongCount: number;
  knownCount: number | null;
  unknownCount: number | null;
  accuracy: number | null;
};

/** 정답률은 소수 첫째 자리 반올림. 플래시카드는 알아요·몰라요만 센다 */
export function countAnswers(mode: QuizMode, answers: AnswerLike[]): StudyCounts {
  if (mode === 'FLASHCARD') {
    const known = answers.filter((a) => a.known === true).length;
    return {
      correctCount: 0,
      wrongCount: 0,
      knownCount: known,
      unknownCount: answers.length - known,
      accuracy: null,
    };
  }
  const correct = answers.filter((a) => a.correct === true).length;
  return {
    correctCount: correct,
    wrongCount: answers.length - correct,
    knownCount: null,
    unknownCount: null,
    accuracy: answers.length > 0 ? Math.round((correct / answers.length) * 1000) / 10 : null,
  };
}

/** 정답 1개당 XP: 4지선다 1, 직접 입력 2, 오답노트 복습은 방식과 상관없이 1. 플래시카드는 0 */
export function answerXpRate(mode: QuizMode, source: StudySource): number {
  if (mode === 'FLASHCARD') return 0;
  if (source === 'WRONG_NOTE') return 1;
  return mode === 'TYPING' ? 2 : 1;
}

/** 너무 빨리 낸 정답은 XP에서 뺀다 */
export function answerXp(mode: QuizMode, source: StudySource, answers: AnswerLike[]) {
  const rate = answerXpRate(mode, source);
  const correct = answers.filter((a) => a.correct === true);
  const counted = correct.filter((a) => a.counted).length;
  return { amount: counted * rate, tooFast: rate > 0 && counted < correct.length };
}

/** 완주: 팩의 모든 단어를 4지선다·직접 입력으로 끝까지 풂 (오답이 있어도 됨) */
export function isPackComplete(session: {
  source: StudySource;
  mode: QuizMode;
  coversPack: boolean;
  total: number;
  answered: number;
  reason: StudyEndReason;
}): boolean {
  return (
    session.reason === 'FINISHED' &&
    session.source === 'PACK' &&
    session.mode !== 'FLASHCARD' &&
    session.coversPack &&
    session.answered === session.total
  );
}

/** 여러 사유가 겹치면 하루 상한 → 같은 팩 하루 1회 → 너무 빠름 → 그만두기 순으로 하나만 알려준다 */
export function blockedReasonOf(flags: {
  capped: boolean;
  bonusRepeated: boolean;
  tooFast: boolean;
  quit: boolean;
}): XpBlockReason | null {
  if (flags.capped) return 'DAILY_CAP';
  if (flags.bonusRepeated) return 'REPEAT_LIMIT';
  if (flags.tooFast) return 'TOO_FAST';
  if (flags.quit) return 'NOT_COMPLETED';
  return null;
}

export type StreakState = { current: number; best: number; lastDate: string | null };

/** 하루(KST)에 학습을 1회 이상 끝내면 인정. 어제 이어서 하면 +1, 끊기면 1부터 */
export function nextStreak(
  previous: StreakState | null,
  today: string,
): StreakState & { increased: boolean } {
  const state = previous ?? { current: 0, best: 0, lastDate: null };
  if (state.lastDate === today) return { ...state, increased: false };
  const yesterday = Temporal.PlainDate.from(today).subtract({ days: 1 }).toString();
  const current = state.lastDate === yesterday ? state.current + 1 : 1;
  return { current, best: Math.max(state.best, current), lastDate: today, increased: true };
}
