import { randomInt } from 'node:crypto';
import type { QuizDirection } from '../../common/enums.js';
import type { ChallengeQuestion } from '../../infra/db/schema/index.js';
import { type PracticeAnswer, scorePractice } from '../practice/practice-scoring.js';
import { buildQuestion, type QuizWord, type Random } from '../study/question-builder.js';

/** 오늘의 챌린지 설정 (모두 같은 문제) */
export const CHALLENGE_SETTINGS = {
  questionType: 'KO_TO_EN_CHOICE',
  questionCount: 10,
  timeLimitSec: 10,
} as const;
/** 정답 1개당 XP (하루 500 상한 포함) */
export const CHALLENGE_XP_PER_CORRECT = 3;
/** 문항 사이 넘어가는 시간과 네트워크 지연을 감안한 여유 */
const TRANSITION_MS = 1000;
const SLACK_MS = 10_000;

/** 시작 시각부터 이때까지 끝내야 답을 인정한다 (모든 문항을 제한 시간까지 쓴 경우 + 여유) */
export function challengeDeadline(startedAt: Date, questionCount: number, timeLimitSec: number) {
  return new Date(
    startedAt.getTime() + questionCount * (timeLimitSec * 1000 + TRANSITION_MS) + SLACK_MS,
  );
}

/**
 * 무작위 순서의 후보 단어로 문항을 만든다. 오답 보기는 그 단어의 단어팩에서 고르고,
 * 보기를 만들 수 없는 단어·이미 낸 단어는 건너뛴다. 모자라면 null
 */
export function pickChallengeQuestions(
  candidates: readonly QuizWord[],
  poolOf: (packId: string) => readonly QuizWord[],
  count: number,
  direction: QuizDirection,
  random: Random = randomInt,
): ChallengeQuestion[] | null {
  const questions: ChallengeQuestion[] = [];
  const used = new Set<string>();
  for (const word of candidates) {
    if (questions.length === count) break;
    const english = word.english.toLowerCase();
    if (used.has(english)) continue;
    const built = buildQuestion(
      word,
      questions.length,
      'CHOICE',
      direction,
      [poolOf(word.packId)],
      random,
    );
    if (!built?.choices || built.answerIndex === null) continue;
    used.add(english);
    questions.push({
      index: built.idx,
      wordId: word.id,
      packId: word.packId,
      prompt: built.prompt,
      choices: built.choices,
      answerIndex: built.answerIndex,
    });
  }
  return questions.length === count ? questions : null;
}

/** 연습과 같은 점수. 마감이 지나 끝냈으면 모든 문항을 미응답으로 본다 */
export function scoreChallenge(
  questions: readonly ChallengeQuestion[],
  answers: readonly PracticeAnswer[],
  limitMs: number,
  inTime: boolean,
) {
  const counted = inTime ? answers : [];
  const { score, correctCount } = scorePractice(questions, counted, limitMs);
  const answerOf = new Map(counted.map((answer) => [answer.index, answer]));
  const results = questions.map((question) => {
    const answer = answerOf.get(question.index);
    return {
      index: question.index,
      correct: Boolean(
        answer &&
          answer.elapsedMs <= limitMs &&
          answer.choiceIndex !== null &&
          answer.choiceIndex === question.answerIndex,
      ),
      answerIndex: question.answerIndex,
    };
  });
  return { score, correctCount, results };
}
