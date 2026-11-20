import { randomInt } from 'node:crypto';
import type { QuestionType, QuizDirection, QuizMode } from '../../common/enums.js';

export const CHOICE_COUNT = 4;
const SAMPLE_ATTEMPTS = 12;

export type QuizWord = {
  id: string;
  packId: string;
  english: string;
  meanings: string[];
  derivatives: string[];
};

export type BuiltQuestion = {
  idx: number;
  wordId: string;
  questionType: QuestionType | null;
  prompt: string;
  derivatives: string[];
  choices: string[] | null;
  answerIndex: number | null;
  acceptedAnswers: string[] | null;
  card: { english: string; meanings: string[] } | null;
};

export type Random = (max: number) => number;

export const questionTypeOf = (mode: QuizMode, direction: QuizDirection): QuestionType | null =>
  mode === 'FLASHCARD' ? null : `${direction}_${mode}`;

export function shuffled<T>(items: readonly T[], random: Random = randomInt): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [result[i], result[j]] = [result[j] as T, result[i] as T];
  }
  return result;
}

/** 보기에 보이는 글자: EN_TO_KO는 대표 뜻, KO_TO_EN은 영어 */
const choiceText = (word: QuizWord, direction: QuizDirection) =>
  direction === 'EN_TO_KO' ? (word.meanings[0] as string) : word.english;

/**
 * 오답 보기 3개. 보이는 글자가 정답이나 다른 보기와 같으면(대소문자 무시) 정답이 둘로 보이므로 뺀다.
 * pools를 앞에서부터 쓰고 모자라면 다음 pool에서 채운다. 끝까지 모자라면 null
 */
export function pickDistractors(
  word: QuizWord,
  direction: QuizDirection,
  pools: readonly (readonly QuizWord[])[],
  random: Random = randomInt,
): string[] | null {
  const seen = new Set([choiceText(word, direction).toLowerCase()]);
  const picked: string[] = [];
  const tryPick = (candidate: QuizWord) => {
    if (candidate.id === word.id) return false;
    const text = choiceText(candidate, direction);
    if (seen.has(text.toLowerCase())) return false;
    seen.add(text.toLowerCase());
    picked.push(text);
    return picked.length === CHOICE_COUNT - 1;
  };
  for (const pool of pools) {
    // 큰 팩에서 문항마다 전체를 섞지 않도록 먼저 무작위로 몇 번 뽑아 보고, 모자랄 때만 전체를 훑는다
    for (let attempt = 0; attempt < SAMPLE_ATTEMPTS && pool.length > 0; attempt++) {
      if (tryPick(pool[random(pool.length)] as QuizWord)) return picked;
    }
    for (const candidate of shuffled(pool, random)) {
      if (tryPick(candidate)) return picked;
    }
  }
  return null;
}

/** 보기가 모자라 만들 수 없으면 null */
export function buildQuestion(
  word: QuizWord,
  idx: number,
  mode: QuizMode,
  direction: QuizDirection,
  distractorPools: readonly (readonly QuizWord[])[],
  random: Random = randomInt,
): BuiltQuestion | null {
  const enToKo = direction === 'EN_TO_KO';
  const question: BuiltQuestion = {
    idx,
    wordId: word.id,
    questionType: questionTypeOf(mode, direction),
    prompt: enToKo ? word.english : word.meanings.join(', '),
    derivatives: word.derivatives,
    choices: null,
    answerIndex: null,
    acceptedAnswers: null,
    card: null,
  };
  if (mode === 'FLASHCARD') {
    question.card = { english: word.english, meanings: word.meanings };
  } else if (mode === 'TYPING') {
    question.acceptedAnswers = enToKo ? word.meanings : [word.english];
  } else {
    const distractors = pickDistractors(word, direction, distractorPools, random);
    if (!distractors) return null;
    const answerIndex = random(CHOICE_COUNT);
    const choices = [...distractors];
    choices.splice(answerIndex, 0, choiceText(word, direction));
    question.choices = choices;
    question.answerIndex = answerIndex;
  }
  return question;
}
