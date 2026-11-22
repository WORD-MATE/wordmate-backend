import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../../infra/db/db.module.js';
import { morningSentences } from '../../../infra/db/schema/index.js';
import { newId } from '../../../infra/db/uuid.js';
import {
  contentIssues,
  Highlight,
  MorningKeywordInput,
  MorningQuizInput,
  replaceContent,
} from '../morning-content.js';

const text = (max: number) => z.string().trim().min(1).max(max);

const Sentence = z
  .object({
    date: z.iso.date(),
    sentence: text(500),
    translation: text(500),
    // 시드는 강조 위치를 직접 적는다
    keywords: z
      .array(MorningKeywordInput.extend({ highlight: Highlight }))
      .min(1)
      .max(10),
    quizzes: z.array(MorningQuizInput).min(1).max(10),
  })
  .superRefine((value, ctx) => {
    for (const issue of contentIssues(value)) {
      ctx.addIssue({ code: 'custom', path: issue.path, message: issue.message });
    }
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
      await replaceContent(tx, sentenceId, item.keywords, item.quizzes);
    });
  }
  return { created, updated };
}
