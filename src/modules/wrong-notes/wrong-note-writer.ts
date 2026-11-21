import { sql } from 'drizzle-orm';
import type { QuestionType, WrongSource } from '../../common/enums.js';
import type { Transaction } from '../../infra/db/db.module.js';
import { wrongNotes } from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';

export type WrongWord = {
  userId: string;
  wordId: string;
  packId: string;
  questionType: QuestionType;
};

/**
 * 틀린 단어를 (사용자, 단어, 문제 유형)별로 오답노트에 쌓는다. 졸업했던 항목은 다시 ACTIVE, 연속 정답은 0.
 * 같은 단어를 한 번에 여러 번 넘기면 그만큼 세므로 호출하는 쪽에서 한 번씩만 넘긴다
 */
export async function recordWrongWords(
  tx: Transaction,
  rows: WrongWord[],
  source: WrongSource,
  now: Date,
): Promise<void> {
  if (rows.length === 0) return;
  // 같은 행을 건드리는 트랜잭션끼리 잠그는 순서를 맞춰 교착을 피한다
  const sorted = [...rows].sort(
    (a, b) => a.userId.localeCompare(b.userId) || a.wordId.localeCompare(b.wordId),
  );
  await tx
    .insert(wrongNotes)
    .values(
      sorted.map((row) => ({
        id: newId(),
        ...row,
        source,
        firstWrongAt: now,
        lastWrongAt: now,
      })),
    )
    .onDuplicateKeyUpdate({
      set: {
        status: 'ACTIVE',
        wrongCount: sql`${wrongNotes.wrongCount} + 1`,
        consecutiveCorrect: 0,
        source,
        lastWrongAt: now,
        graduatedAt: null,
      },
    });
}
