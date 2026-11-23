import { scoreOf } from '../battles/battle-rules.js';

export type PracticeQuestion = {
  index: number;
  wordId: string;
  prompt: string;
  choices: string[];
  answerIndex: number;
};
export type PracticeAnswer = { index: number; choiceIndex: number | null; elapsedMs: number };

/**
 * 대결과 같은 점수(정답 100 + 남은 시간 비례 보너스 최대 50). 제한 시간을 넘긴 답과 보내지 않은 문항은 미응답.
 * 틀렸거나 답하지 않은 단어는 한 번씩 돌려준다 (오답노트용)
 */
export function scorePractice(
  questions: readonly PracticeQuestion[],
  answers: readonly PracticeAnswer[],
  limitMs: number,
): { score: number; correctCount: number; wrongWordIds: string[] } {
  const answerOf = new Map(answers.map((answer) => [answer.index, answer]));
  let score = 0;
  let correctCount = 0;
  const wrong = new Set<string>();
  for (const question of questions) {
    const answer = answerOf.get(question.index);
    const inTime = answer && answer.choiceIndex !== null && answer.elapsedMs <= limitMs;
    const correct = Boolean(inTime && answer.choiceIndex === question.answerIndex);
    if (correct && answer) {
      correctCount++;
      score += scoreOf(true, limitMs - answer.elapsedMs, limitMs);
    } else {
      wrong.add(question.wordId);
    }
  }
  return { score, correctCount, wrongWordIds: [...wrong] };
}
