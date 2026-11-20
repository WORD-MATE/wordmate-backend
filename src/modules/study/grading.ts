import type { MemoryStatus, QuizDirection } from '../../common/enums.js';

/** 이보다 빨리 낸 답은 점수·XP·암기 진행에서 뺀다 */
export const MIN_COUNTED_ELAPSED_MS = 500;
/** 서로 다른 학습에서 이만큼 연속으로 맞히면 MEMORIZED */
export const MEMORIZED_STREAK = 3;
/** 같은 방식으로 이만큼 연속으로 맞히면 오답노트에서 자동 졸업 */
export const GRADUATE_STREAK = 2;

/** 앞뒤 공백 제거, 소문자, 연속 공백은 한 칸 */
export const normalizeTyped = (value: string): string =>
  value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

/** EN_TO_KO는 띄어쓰기를 무시하고 뜻 중 하나와 같으면 정답, KO_TO_EN은 영어와 비교 */
export function gradeTyping(
  typed: string,
  direction: QuizDirection,
  acceptedAnswers: string[],
): boolean {
  const normalized = normalizeTyped(typed);
  if (direction === 'EN_TO_KO') {
    const compact = normalized.replaceAll(' ', '');
    return acceptedAnswers.some((answer) => normalizeTyped(answer).replaceAll(' ', '') === compact);
  }
  return acceptedAnswers.some((answer) => normalizeTyped(answer) === normalized);
}

export type ProgressState = {
  memoryStatus: MemoryStatus;
  correctStreak: number;
  lastCorrectSessionId: string | null;
  totalCorrect: number;
  totalWrong: number;
};

/**
 * 답 하나를 반영한 암기 진행. FLASHCARD는 "알아요"를 정답으로 본다.
 * - 처음 답하면 LEARNING
 * - 연속 정답은 학습마다 한 번만 센다 (한 학습에서 같은 단어를 여러 번 맞혀도 1)
 * - 너무 빨리 낸 정답은 연속 정답에 넣지 않는다
 * - 틀리면 연속 정답이 0이 되고 MEMORIZED였으면 LEARNING으로 내려간다
 */
export function nextProgress(
  previous: ProgressState | null,
  answer: { correct: boolean; counted: boolean; sessionId: string } | null,
): ProgressState {
  const base: ProgressState = previous ?? {
    memoryStatus: 'LEARNING',
    correctStreak: 0,
    lastCorrectSessionId: null,
    totalCorrect: 0,
    totalWrong: 0,
  };
  // answer가 없으면 아직 아무 답도 반영하지 않은 처음 상태
  if (!answer) return base;
  if (!answer.correct) {
    return {
      ...base,
      memoryStatus: 'LEARNING',
      correctStreak: 0,
      lastCorrectSessionId: null,
      totalWrong: base.totalWrong + 1,
    };
  }
  const advances = answer.counted && base.lastCorrectSessionId !== answer.sessionId;
  const correctStreak = advances ? base.correctStreak + 1 : base.correctStreak;
  return {
    memoryStatus:
      correctStreak >= MEMORIZED_STREAK || base.memoryStatus === 'MEMORIZED'
        ? 'MEMORIZED'
        : 'LEARNING',
    correctStreak,
    lastCorrectSessionId: advances ? answer.sessionId : base.lastCorrectSessionId,
    totalCorrect: base.totalCorrect + 1,
    totalWrong: base.totalWrong,
  };
}

/** 복습 간격(일). 복습에서 맞힐 때마다 다음 간격으로, 다 통과하면 일정에서 빠진다 */
export const REVIEW_INTERVALS = [1, 3, 7, 14, 30] as const;
/** 하루에 내는 복습 단어 수 */
export const DAILY_REVIEW_LIMIT = 30;

export type ReviewState = {
  reviewStage: number;
  nextReviewOn: string | null;
  lastReviewedOn: string | null;
};

const addDays = (date: string, days: number) =>
  Temporal.PlainDate.from(date).add({ days }).toString();

/**
 * 답 하나를 반영한 복습 일정 (today는 KST 날짜).
 * - 처음 답하면 다음 날 복습
 * - 틀리면 어디서 틀렸든 첫 간격(다음 날)부터 다시
 * - 복습 학습에서 오늘 복습할 단어를 맞히면 다음 간격으로. 너무 빨리 낸 정답은 넘어가지 않는다
 * - 일반 학습에서 맞힌 것은 일정을 바꾸지 않는다
 */
export function nextReview(
  previous: ReviewState | null,
  answer: { correct: boolean; counted: boolean; isReview: boolean },
  today: string,
): ReviewState {
  const base: ReviewState = previous ?? {
    reviewStage: 0,
    nextReviewOn: null,
    lastReviewedOn: null,
  };
  const lastReviewedOn = answer.isReview ? today : base.lastReviewedOn;
  const fresh = base.reviewStage === 0 && base.nextReviewOn === null;
  if (!answer.correct || fresh) {
    return { reviewStage: 0, nextReviewOn: addDays(today, REVIEW_INTERVALS[0]), lastReviewedOn };
  }
  const due = base.nextReviewOn !== null && base.nextReviewOn <= today;
  if (!answer.isReview || !answer.counted || !due) return { ...base, lastReviewedOn };
  const reviewStage = base.reviewStage + 1;
  const interval = REVIEW_INTERVALS[reviewStage];
  return {
    reviewStage,
    nextReviewOn: interval === undefined ? null : addDays(today, interval),
    lastReviewedOn,
  };
}
