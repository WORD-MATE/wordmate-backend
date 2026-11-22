import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { MORNING_QUIZ_TYPE } from '../../../common/enums.js';
import type { Database } from '../../../infra/db/db.module.js';
import {
  morningKeywords,
  morningQuizzes,
  morningSentences,
} from '../../../infra/db/schema/index.js';
import { newId } from '../../../infra/db/uuid.js';
import { WordInput } from '../../words/words.schemas.js';

const text = (max: number) => z.string().trim().min(1).max(max);

// 내 단어팩에 그대로 저장하므로 단어 추가와 같은 규칙으로 정규화한다
const Keyword = z.object({
  english: WordInput.shape.english,
  meanings: WordInput.shape.meanings,
  example: text(500).optional(),
  highlight: z.object({ start: z.number().int().min(0), end: z.number().int().min(1) }),
});

const Quiz = z.object({
  type: z.enum(MORNING_QUIZ_TYPE),
  question: text(500),
  choices: z.array(text(200)).min(2).max(5).optional(),
  answers: z.array(text(200)).min(1),
  explanation: text(500).optional(),
});

const Sentence = z
  .object({
    date: z.iso.date(),
    sentence: text(500),
    translation: text(500),
    keywords: z.array(Keyword).min(1).max(10),
    quizzes: z.array(Quiz).min(1).max(10),
  })
  .superRefine((value, ctx) => {
    const englishes = value.keywords.map((k) => k.english.toLowerCase());
    if (new Set(englishes).size !== englishes.length) {
      ctx.addIssue({ code: 'custom', path: ['keywords'], message: '핵심 어휘가 겹칩니다.' });
    }
    value.keywords.forEach((keyword, index) => {
      const { start, end } = keyword.highlight;
      if (start >= end || end > value.sentence.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['keywords', index, 'highlight'],
          message: '강조 위치가 문장 밖입니다.',
        });
      }
    });
    value.quizzes.forEach((quiz, index) => {
      const lower = value.sentence.toLowerCase();
      if (
        quiz.type === 'FILL_BLANK' &&
        !quiz.answers.some((a) => lower.includes(a.toLowerCase()))
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['quizzes', index, 'answers'],
          message: '빈칸 정답이 문장 안에 없습니다.',
        });
      }
      if (quiz.choices && !quiz.answers.every((a) => quiz.choices?.includes(a))) {
        ctx.addIssue({
          code: 'custom',
          path: ['quizzes', index, 'answers'],
          message: '객관식 정답이 보기에 없습니다.',
        });
      }
    });
  });

export const MorningSeed = z
  .object({ sentences: z.array(Sentence).min(1) })
  .superRefine((value, ctx) => {
    const dates = value.sentences.map((s) => s.date);
    if (new Set(dates).size !== dates.length) {
      ctx.addIssue({ code: 'custom', path: ['sentences'], message: '날짜가 겹칩니다.' });
    }
  });
export type MorningSeed = z.infer<typeof MorningSeed>;

/**
 * 날짜마다 게시 상태로 넣는다. 이미 있는 날짜는 내용을 바꾸고
 * 핵심 어휘·퀴즈를 새로 넣는다 (사용자의 완료 기록은 그대로)
 */
export async function applyMorningSeed(
  db: Database,
  seed: MorningSeed,
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const item of seed.sentences) {
    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: morningSentences.id })
        .from(morningSentences)
        .where(eq(morningSentences.publishDate, item.date))
        .for('update');
      const sentenceId = existing?.id ?? newId();
      if (existing) {
        await tx
          .update(morningSentences)
          .set({ sentence: item.sentence, translation: item.translation, status: 'PUBLISHED' })
          .where(eq(morningSentences.id, sentenceId));
        await tx.delete(morningKeywords).where(eq(morningKeywords.sentenceId, sentenceId));
        await tx.delete(morningQuizzes).where(eq(morningQuizzes.sentenceId, sentenceId));
        updated++;
      } else {
        await tx.insert(morningSentences).values({
          id: sentenceId,
          publishDate: item.date,
          status: 'PUBLISHED',
          sentence: item.sentence,
          translation: item.translation,
        });
        created++;
      }
      await tx.insert(morningKeywords).values(
        item.keywords.map((k, idx) => ({
          sentenceId,
          idx,
          english: k.english,
          meanings: k.meanings,
          example: k.example ?? null,
          highlightStart: k.highlight.start,
          highlightEnd: k.highlight.end,
        })),
      );
      await tx.insert(morningQuizzes).values(
        item.quizzes.map((q, idx) => ({
          sentenceId,
          idx,
          type: q.type,
          question: q.question,
          choices: q.choices ?? null,
          answers: q.answers,
          explanation: q.explanation ?? null,
        })),
      );
    });
  }
  return { created, updated };
}
