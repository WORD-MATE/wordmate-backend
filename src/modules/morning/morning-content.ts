import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { MORNING_QUIZ_TYPE } from '../../common/enums.js';
import type { Transaction } from '../../infra/db/db.module.js';
import { morningKeywords, morningQuizzes } from '../../infra/db/schema/index.js';
import { WordInput } from '../words/words.schemas.js';

const text = (max: number) => z.string().trim().min(1).max(max);

export const Highlight = z
  .object({ start: z.number().int().min(0), end: z.number().int().min(0) })
  .describe('문장 안 위치. UTF-16 코드 단위, end는 포함하지 않음');

/** 내 단어팩에 그대로 저장하므로 단어 추가와 같은 규칙으로 정규화한다 */
export const MorningKeywordInput = z.object({
  english: WordInput.shape.english,
  meanings: WordInput.shape.meanings,
  example: text(500).nullish(),
  highlight: Highlight.optional().describe('없으면 문장에서 처음 나오는 위치'),
});
export type MorningKeywordInput = z.infer<typeof MorningKeywordInput>;

export const MorningQuizInput = z.object({
  type: z.enum(MORNING_QUIZ_TYPE),
  question: text(500),
  choices: z.array(text(200)).min(2).max(5).nullish().describe('객관식만'),
  answers: z.array(text(200)).min(1).describe('허용 정답'),
  explanation: text(500).nullish(),
});
export type MorningQuizInput = z.infer<typeof MorningQuizInput>;

export type MorningContent = {
  sentence: string;
  translation: string;
  keywords: (MorningKeywordInput & { highlight: z.infer<typeof Highlight> })[];
  quizzes: MorningQuizInput[];
};

export type ContentIssue = {
  code: 'MORNING_INCOMPLETE' | 'MORNING_BLANK_NOT_IN_SENTENCE' | 'MORNING_INVALID';
  path: (string | number)[];
  message: string;
};

/**
 * 강조 위치가 없는 어휘는 문장에서 처음 나오는 위치(대소문자 무시)로, 못 찾으면 빈 위치로 둔다.
 * 다른 단어 안에 든 경우("monkey"의 "key")보다 단어 단위로 나오는 위치를 먼저 쓴다
 */
export function withHighlights(
  sentence: string,
  keywords: MorningKeywordInput[],
): MorningContent['keywords'] {
  const lower = sentence.toLowerCase();
  return keywords.map((keyword) => {
    if (keyword.highlight) return { ...keyword, highlight: keyword.highlight };
    const target = keyword.english.toLowerCase();
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const word = new RegExp(`(?<![a-z])${escaped}(?![a-z])`).exec(lower);
    const start = word ? word.index : lower.indexOf(target);
    return {
      ...keyword,
      highlight: start < 0 ? { start: 0, end: 0 } : { start, end: start + keyword.english.length },
    };
  });
}

/** 게시할 수 있는지. 문장·뜻·어휘·퀴즈가 다 있고, 강조 위치와 정답이 맞아야 한다 */
export function contentIssues(content: MorningContent): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const incomplete = (path: (string | number)[], message: string) =>
    issues.push({ code: 'MORNING_INCOMPLETE', path, message });
  if (!content.sentence.trim()) incomplete(['sentence'], '문장이 없습니다.');
  if (!content.translation.trim()) incomplete(['translation'], '뜻이 없습니다.');
  if (content.keywords.length === 0) incomplete(['keywords'], '핵심 어휘가 없습니다.');
  if (content.quizzes.length === 0) incomplete(['quizzes'], '퀴즈가 없습니다.');

  const englishes = content.keywords.map((k) => k.english.toLowerCase());
  if (new Set(englishes).size !== englishes.length) {
    issues.push({ code: 'MORNING_INVALID', path: ['keywords'], message: '핵심 어휘가 겹칩니다.' });
  }
  content.keywords.forEach((keyword, index) => {
    const { start, end } = keyword.highlight;
    if (start >= end || end > content.sentence.length) {
      issues.push({
        code: 'MORNING_INVALID',
        path: ['keywords', index, 'highlight'],
        message: '강조 위치가 문장 밖이거나 비어 있습니다.',
      });
    }
  });
  const lower = content.sentence.toLowerCase();
  content.quizzes.forEach((quiz, index) => {
    if (quiz.type === 'FILL_BLANK' && !quiz.answers.some((a) => lower.includes(a.toLowerCase()))) {
      issues.push({
        code: 'MORNING_BLANK_NOT_IN_SENTENCE',
        path: ['quizzes', index, 'answers'],
        message: '빈칸 정답이 문장 안에 없습니다.',
      });
    }
    if (quiz.choices && !quiz.answers.every((a) => quiz.choices?.includes(a))) {
      issues.push({
        code: 'MORNING_INVALID',
        path: ['quizzes', index, 'answers'],
        message: '객관식 정답이 보기에 없습니다.',
      });
    }
  });
  return issues;
}

/** 핵심 어휘·퀴즈를 통째로 바꾼다 (사용자의 완료 기록은 그대로) */
export async function replaceContent(
  tx: Transaction,
  sentenceId: string,
  keywords: MorningContent['keywords'],
  quizzes: MorningQuizInput[],
): Promise<void> {
  await tx.delete(morningKeywords).where(eq(morningKeywords.sentenceId, sentenceId));
  await tx.delete(morningQuizzes).where(eq(morningQuizzes.sentenceId, sentenceId));
  if (keywords.length > 0) {
    await tx.insert(morningKeywords).values(
      keywords.map((k, idx) => ({
        sentenceId,
        idx,
        english: k.english,
        meanings: k.meanings,
        example: k.example ?? null,
        highlightStart: k.highlight.start,
        highlightEnd: k.highlight.end,
      })),
    );
  }
  if (quizzes.length > 0) {
    await tx.insert(morningQuizzes).values(
      quizzes.map((q, idx) => ({
        sentenceId,
        idx,
        type: q.type,
        question: q.question,
        choices: q.choices ?? null,
        answers: q.answers,
        explanation: q.explanation ?? null,
      })),
    );
  }
}
