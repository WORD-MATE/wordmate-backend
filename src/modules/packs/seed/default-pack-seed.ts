import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../../../infra/db/db.module.js';
import { packCategories, packs, words } from '../../../infra/db/schema/index.js';
import { newId } from '../../../infra/db/uuid.js';
import { englishKey, meaningsText } from '../../words/word-text.js';
import { MAX_WORDS_PER_PACK, WordInput } from '../../words/words.schemas.js';

const name = (max: number) => z.string().trim().min(1).max(max);
const duplicatesOf = (values: string[]) => [
  ...new Set(values.filter((value, i) => values.indexOf(value) !== i)),
];

/**
 * 기본 단어팩 시드 파일 형식. 분류·팩은 이름으로, 단어는 팩 안에서 영어(대소문자 무시)로 찾는다.
 * 같은 파일을 여러 번 넣어도 결과가 같다
 */
export const DefaultPackSeed = z
  .object({
    categories: z
      .array(z.object({ name: name(30), sortOrder: z.number().int().default(0) }))
      .default([]),
    packs: z
      .array(
        z.object({
          name: name(30),
          category: name(30).nullish().describe('categories의 name'),
          description: z
            .string()
            .trim()
            .max(200)
            .nullish()
            .transform((value) => value || null),
          sortOrder: z.number().int().default(0),
          words: z.array(WordInput).max(MAX_WORDS_PER_PACK),
        }),
      )
      .min(1),
  })
  .superRefine((seed, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path });
    const categoryNames = seed.categories.map((category) => category.name);
    for (const duplicate of duplicatesOf(categoryNames)) {
      issue(`분류 이름이 겹칩니다: ${duplicate}`, ['categories']);
    }
    for (const duplicate of duplicatesOf(seed.packs.map((pack) => pack.name))) {
      issue(`단어팩 이름이 겹칩니다: ${duplicate}`, ['packs']);
    }
    for (const [i, pack] of seed.packs.entries()) {
      if (pack.category && !categoryNames.includes(pack.category)) {
        issue(`categories에 없는 분류입니다: ${pack.category}`, ['packs', i, 'category']);
      }
      for (const duplicate of duplicatesOf(pack.words.map((word) => englishKey(word.english)))) {
        issue(`같은 단어가 두 번 있습니다: ${duplicate}`, ['packs', i, 'words']);
      }
    }
  });
export type DefaultPackSeed = z.infer<typeof DefaultPackSeed>;

export type SeedSummary = {
  categories: { created: number; updated: number };
  packs: { created: number; updated: number };
  words: { created: number; updated: number; removed: number };
};

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * prune이면 파일에 없는 단어를 지운다(소프트 삭제). 아니면 관리자가 API로 추가한 단어도 남긴다.
 * 팩마다 트랜잭션 하나라 중간에 실패해도 그 팩만 되돌아간다
 */
export async function applyDefaultPackSeed(
  db: Database,
  seed: DefaultPackSeed,
  options: { prune?: boolean } = {},
): Promise<SeedSummary> {
  const summary: SeedSummary = {
    categories: { created: 0, updated: 0 },
    packs: { created: 0, updated: 0 },
    words: { created: 0, updated: 0, removed: 0 },
  };

  const categoryIds = new Map<string, string>();
  for (const category of seed.categories) {
    const [existing] = await db
      .select()
      .from(packCategories)
      .where(eq(packCategories.name, category.name));
    if (!existing) {
      const id = newId();
      await db.insert(packCategories).values({ id, ...category });
      categoryIds.set(category.name, id);
      summary.categories.created++;
      continue;
    }
    categoryIds.set(category.name, existing.id);
    if (existing.sortOrder !== category.sortOrder) {
      await db
        .update(packCategories)
        .set({ sortOrder: category.sortOrder })
        .where(eq(packCategories.id, existing.id));
      summary.categories.updated++;
    }
  }

  for (const pack of seed.packs) {
    await db.transaction(async (tx) => {
      const fields = {
        description: pack.description ?? null,
        categoryId: pack.category ? (categoryIds.get(pack.category) ?? null) : null,
        sortOrder: pack.sortOrder,
      };
      const [existing] = await tx
        .select()
        .from(packs)
        .where(and(eq(packs.type, 'DEFAULT'), eq(packs.name, pack.name), isNull(packs.deletedAt)))
        .for('update');
      let packId: string;
      if (existing) {
        packId = existing.id;
        if (
          existing.description !== fields.description ||
          existing.categoryId !== fields.categoryId ||
          existing.sortOrder !== fields.sortOrder
        ) {
          await tx.update(packs).set(fields).where(eq(packs.id, packId));
          summary.packs.updated++;
        }
      } else {
        packId = newId();
        await tx
          .insert(packs)
          .values({ id: packId, type: 'DEFAULT', ownerUserId: null, name: pack.name, ...fields });
        summary.packs.created++;
      }

      const current = await tx
        .select()
        .from(words)
        .where(and(eq(words.packId, packId), isNull(words.deletedAt)));
      const byKey = new Map(current.map((word) => [word.englishNorm, word]));
      const keys: string[] = [];
      const toInsert: (typeof words.$inferInsert)[] = [];
      for (const input of pack.words) {
        const key = englishKey(input.english);
        keys.push(key);
        const values = {
          english: input.english,
          meanings: input.meanings,
          meaningsText: meaningsText(input.meanings),
          example: input.example ?? null,
          derivatives: input.derivatives ?? [],
        };
        const word = byKey.get(key);
        if (!word) {
          toInsert.push({ id: newId(), packId, englishNorm: key, ...values });
        } else if (
          word.english !== values.english ||
          word.example !== values.example ||
          !sameJson(word.meanings, values.meanings) ||
          !sameJson(word.derivatives, values.derivatives)
        ) {
          await tx.update(words).set(values).where(eq(words.id, word.id));
          summary.words.updated++;
        }
      }
      // 관리자가 API로 추가한 단어와 합쳐 팩 한도를 넘으면 이 팩은 넣지 않는다 (prune이면 지울 단어는 빼고 센다)
      const inFile = new Set(keys);
      const kept = options.prune
        ? current.filter((word) => inFile.has(word.englishNorm)).length
        : current.length;
      if (kept + toInsert.length > MAX_WORDS_PER_PACK) {
        throw new Error(
          `${pack.name}: 남는 단어 ${kept}개 + 새 단어 ${toInsert.length}개가 팩 한도(${MAX_WORDS_PER_PACK}개)를 넘습니다.`,
        );
      }
      for (let i = 0; i < toInsert.length; i += 500) {
        await tx.insert(words).values(toInsert.slice(i, i + 500));
      }
      summary.words.created += toInsert.length;

      if (options.prune) {
        const [removed] = await tx
          .update(words)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(words.packId, packId),
              isNull(words.deletedAt),
              keys.length > 0 ? notInArray(words.englishNorm, keys) : undefined,
            ),
          );
        summary.words.removed += removed.affectedRows;
      }

      // 관리자가 API로 추가한 단어가 남을 수 있어 실제 개수로 맞춘다
      await tx
        .update(packs)
        .set({
          // eq로 써야 pack_id(BINARY)에 맞게 값이 변환된다
          wordCount: sql`(SELECT COUNT(*) FROM ${words} WHERE ${eq(words.packId, packId)} AND ${isNull(words.deletedAt)})`,
        })
        .where(eq(packs.id, packId));
    });
  }
  return summary;
}
