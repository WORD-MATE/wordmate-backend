import { randomInt } from 'node:crypto';
import type { BattleOutcome, QuizDirection, XpBlockReason } from '../../common/enums.js';
import {
  type BuiltQuestion,
  buildQuestion,
  pickDistractors,
  type QuizWord,
  type Random,
  shuffled,
} from '../study/question-builder.js';

export const CORRECT_SCORE = 100;
export const MAX_SPEED_BONUS = 50;

export type BattleQuestion = Pick<BuiltQuestion, 'idx' | 'wordId' | 'prompt'> & {
  choices: string[];
  answerIndex: number;
};

/**
 * 오답 보기를 만들 수 있는 단어만 섞어서 문항 수만큼 낸다. 단어가 모자라면 한 바퀴씩 다시 섞어 중복 출제한다.
 * 보기를 만들 수 있는 단어가 없으면 null
 */
export function buildBattleQuestions(
  words: readonly QuizWord[],
  count: number,
  direction: QuizDirection,
  random: Random = randomInt,
): BattleQuestion[] | null {
  const usable = words.filter((word) => pickDistractors(word, direction, [words], random));
  if (usable.length === 0) return null;
  const order: QuizWord[] = [];
  while (order.length < count) {
    const round = shuffled(usable, random);
    // 바퀴가 바뀔 때 같은 단어가 연달아 나오지 않게
    if (round.length > 1 && round[0]?.id === order.at(-1)?.id) {
      round.push(round.shift() as QuizWord);
    }
    order.push(...round);
  }
  const questions: BattleQuestion[] = [];
  for (const [idx, word] of order.slice(0, count).entries()) {
    const built = buildQuestion(word, idx, 'CHOICE', direction, [words], random);
    if (!built?.choices || built.answerIndex === null) return null;
    questions.push({
      idx,
      wordId: built.wordId,
      prompt: built.prompt,
      choices: built.choices,
      answerIndex: built.answerIndex,
    });
  }
  return questions;
}

/** 정답 100점 + 남은 시간에 비례한 보너스(최대 50, 반올림). 오답·미응답 0점 */
export function scoreOf(correct: boolean, remainingMs: number, limitMs: number): number {
  if (!correct) return 0;
  const remaining = Math.min(Math.max(remainingMs, 0), limitMs);
  return CORRECT_SCORE + Math.round((MAX_SPEED_BONUS * remaining) / limitMs);
}

export type PlayerTotal = { userId: string; score: number; totalTimeMs: number };
export type RankedPlayer = PlayerTotal & { rank: number };

/** 점수 높은 순, 같으면 총 풀이 시간 짧은 순. 둘 다 같으면 같은 순위 */
export function rankPlayers(totals: readonly PlayerTotal[]): RankedPlayer[] {
  const sorted = [...totals].sort(
    (a, b) =>
      b.score - a.score || a.totalTimeMs - b.totalTimeMs || a.userId.localeCompare(b.userId),
  );
  const ranked: RankedPlayer[] = [];
  for (const [i, player] of sorted.entries()) {
    const prev = ranked[i - 1];
    const tied = prev?.score === player.score && prev.totalTimeMs === player.totalTimeMs;
    ranked.push({ ...player, rank: tied ? prev.rank : i + 1 });
  }
  return ranked;
}

export const BATTLE_XP = { WIN: 30, DRAW: 15, LOSE: 5 } as const;
/** 같은 상대와 하루에 XP를 받는 완주 대결 수 */
export const DAILY_PAIR_LIMIT = 3;

export type FinalPlayer = PlayerTotal & { completed: boolean };
export type FinalResult = FinalPlayer & { rank: number | null; outcome: BattleOutcome };

/**
 * 완주자끼리 순위를 매긴다. 1위가 여럿이면 DRAW, 나머지 완주자는 LOSE, 중도 이탈은 LEFT(순위 없음).
 * 둘 이상이 시작했는데 혼자만 완주했으면 WIN_BY_FORFEIT
 */
export function decideOutcomes(players: readonly FinalPlayer[]): FinalResult[] {
  const finishers = rankPlayers(players.filter((player) => player.completed));
  const forfeit = finishers.length === 1 && players.length > 1;
  const winners = finishers.filter((player) => player.rank === 1).length;
  const ranked: FinalResult[] = finishers.map((player) => {
    const outcome: BattleOutcome = forfeit
      ? 'WIN_BY_FORFEIT'
      : player.rank !== 1
        ? 'LOSE'
        : winners > 1
          ? 'DRAW'
          : 'WIN';
    return { ...player, completed: true, outcome };
  });
  const left = players
    .filter((player) => !player.completed)
    .sort((a, b) => b.score - a.score || a.userId.localeCompare(b.userId))
    .map((player) => ({ ...player, rank: null, outcome: 'LEFT' as const }));
  return [...ranked, ...left];
}

/** 결과별 XP. 하루 상한(DAILY_CAP)은 지급할 때 정한다 */
export function battleXpOf(
  outcome: BattleOutcome,
  repeatLimited: boolean,
): { amount: number; blockedReason: XpBlockReason | null } {
  if (outcome === 'LEFT') return { amount: 0, blockedReason: 'NOT_COMPLETED' };
  if (outcome === 'WIN_BY_FORFEIT') return { amount: 0, blockedReason: 'FORFEIT' };
  if (repeatLimited) return { amount: 0, blockedReason: 'REPEAT_LIMIT' };
  return { amount: BATTLE_XP[outcome], blockedReason: null };
}
