import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, inArray, isNull, type SQL, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { type CursorPage, decodeCursor, toCursorPage } from '../../common/pagination.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import {
  type Pack,
  packs,
  userWordProgress,
  type Word,
  words,
} from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { ForbiddenWordsService } from '../forbidden-words/forbidden-words.service.js';
import { PackErrors, PacksService } from '../packs/packs.service.js';
import { readWordFile } from './import/word-file.js';
import { WordErrors } from './word-common.js';
import { englishKey, meaningsText, type ParsedLine, parseCells, parseText } from './word-text.js';
import { WordViewerService } from './word-viewer.service.js';
import {
  type AddWords,
  type AddWordsResult,
  MAX_WORDS_PER_PACK,
  type ParseResult,
  type UpdateWord,
  type WordInput,
  type WordItem,
  type WordListQuery,
} from './words.schemas.js';

const ACTIVE_ENGLISH_INDEX = 'words_active_english_uq';
const IdCursor = z.object({ id: z.uuid() });

/** example·derivatives는 기본 단어팩 전용이라 내 단어팩에서는 버린다 */
const extrasFor = (pack: Pack, input: Pick<WordInput, 'example' | 'derivatives'>) =>
  pack.type === 'DEFAULT' ? { example: input.example, derivatives: input.derivatives } : {};

@Injectable()
export class WordsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly packs: PacksService,
    private readonly forbiddenWords: ForbiddenWordsService,
    private readonly viewer: WordViewerService,
  ) {}

  async list(user: AuthUser, packId: string, query: WordListQuery): Promise<CursorPage<WordItem>> {
    const pack = await this.packs.findVisible(user, packId);
    const cursor = query.cursor && decodeCursor(query.cursor, IdCursor);
    // 진행 기록이 없으면 NEW
    let statusCondition: SQL | undefined;
    if (query.memoryStatus === 'NEW') statusCondition = isNull(userWordProgress.wordId);
    else if (query.memoryStatus) {
      statusCondition = eq(userWordProgress.memoryStatus, query.memoryStatus);
    }
    const rows = await this.db
      .select({ word: words })
      .from(words)
      .leftJoin(
        userWordProgress,
        and(eq(userWordProgress.wordId, words.id), eq(userWordProgress.userId, user.userId)),
      )
      .where(
        and(
          eq(words.packId, pack.id),
          isNull(words.deletedAt),
          statusCondition,
          cursor ? gt(words.id, cursor.id) : undefined,
        ),
      )
      .orderBy(asc(words.id))
      .limit(query.size + 1);
    const page = toCursorPage(rows, query.size, (last) => ({ id: last.word.id }));
    return {
      items: await this.viewer.items(
        user.userId,
        page.items.map((row) => row.word),
      ),
      nextCursor: page.nextCursor,
    };
  }

  async add(user: AuthUser, packId: string, body: AddWords): Promise<AddWordsResult> {
    const pack = await this.packs.findEditable(user, packId);

    // 요청 안에서 같은 단어가 겹치면 처음 것만 쓴다
    const unique = new Map<string, WordInput>();
    for (const input of body.words) {
      const key = englishKey(input.english);
      if (!unique.has(key)) unique.set(key, input);
    }
    if (pack.shareCode) await this.assertClean(pack, [...unique.values()]);

    try {
      const result = await this.db.transaction(async (tx) => {
        // 팩 행을 잠가 동시에 추가해도 한도와 wordCount가 어긋나지 않게 한다
        const [locked] = await tx
          .select({ wordCount: packs.wordCount })
          .from(packs)
          .where(and(eq(packs.id, pack.id), isNull(packs.deletedAt)))
          .for('update');
        if (!locked) throw PackErrors.notFound();

        const existing = await tx
          .select({ id: words.id, englishNorm: words.englishNorm })
          .from(words)
          .where(
            and(
              eq(words.packId, pack.id),
              isNull(words.deletedAt),
              inArray(words.englishNorm, [...unique.keys()]),
            ),
          );
        const existingIds = new Map(existing.map((row) => [row.englishNorm, row.id]));

        const toInsert: (typeof words.$inferInsert & { id: string })[] = [];
        const toOverwrite: { id: string; input: WordInput }[] = [];
        for (const [key, input] of unique) {
          const id = existingIds.get(key);
          if (id) {
            if (body.duplicatePolicy === 'OVERWRITE') toOverwrite.push({ id, input });
          } else {
            toInsert.push({
              id: newId(),
              packId: pack.id,
              english: input.english,
              englishNorm: key,
              meanings: input.meanings,
              meaningsText: meaningsText(input.meanings),
              ...extrasFor(pack, input),
            });
          }
        }

        const capacity = Math.max(0, MAX_WORDS_PER_PACK - locked.wordCount);
        const inserted = toInsert.slice(0, capacity);
        if (inserted.length > 0) {
          await tx.insert(words).values(inserted);
          await tx
            .update(packs)
            .set({ wordCount: sql`${packs.wordCount} + ${inserted.length}` })
            .where(eq(packs.id, pack.id));
        }
        for (const { id, input } of toOverwrite) {
          await tx
            .update(words)
            .set({
              english: input.english,
              meanings: input.meanings,
              meaningsText: meaningsText(input.meanings),
              ...extrasFor(pack, input),
            })
            .where(eq(words.id, id));
        }

        const savedIds = [...inserted.map((row) => row.id), ...toOverwrite.map(({ id }) => id)];
        const saved =
          savedIds.length > 0
            ? await tx
                .select()
                .from(words)
                .where(inArray(words.id, savedIds))
                .orderBy(asc(words.id))
            : [];
        return {
          added: inserted.length,
          skipped:
            body.words.length -
            unique.size +
            (body.duplicatePolicy === 'SKIP' ? existing.length : 0),
          overwritten: toOverwrite.length,
          excluded: toInsert.length - inserted.length,
          words: saved,
        };
      });
      return { ...result, words: await this.viewer.items(user.userId, result.words) };
    } catch (error) {
      if (isDuplicateKeyError(error, ACTIVE_ENGLISH_INDEX)) throw WordErrors.duplicate();
      throw error;
    }
  }

  async parse(user: AuthUser, packId: string, text: string): Promise<ParseResult> {
    const pack = await this.packs.findEditable(user, packId);
    const rows = parseText(text);
    if (rows.length > MAX_WORDS_PER_PACK) throw WordErrors.tooManyLines();
    return this.markDuplicates(pack, rows);
  }

  /** 파일을 읽기 전에 권한부터 확인한다 (남의 팩에 큰 파일을 올려도 분석하지 않음) */
  async importFile(
    user: AuthUser,
    packId: string,
    readFile: () => Promise<Buffer>,
  ): Promise<ParseResult> {
    const pack = await this.packs.findEditable(user, packId);
    const rows = readWordFile(await readFile());
    return this.markDuplicates(
      pack,
      rows.map(({ line, cells }) => ({ line, ...parseCells(cells[0], cells[1]) })),
    );
  }

  private async markDuplicates(
    pack: Pack,
    rows: (ParsedLine & { line: number })[],
  ): Promise<ParseResult> {
    const keys = [
      ...new Set(rows.flatMap((row) => (row.english ? [englishKey(row.english)] : []))),
    ];
    const existing =
      keys.length > 0
        ? await this.db
            .select({ englishNorm: words.englishNorm })
            .from(words)
            .where(
              and(
                eq(words.packId, pack.id),
                isNull(words.deletedAt),
                inArray(words.englishNorm, keys),
              ),
            )
        : [];
    const existingKeys = new Set(existing.map((row) => row.englishNorm));
    return {
      rows: rows.map((row) => ({
        ...row,
        duplicate: row.english !== null && existingKeys.has(englishKey(row.english)),
      })),
    };
  }

  async update(
    user: AuthUser,
    packId: string,
    wordId: string,
    body: UpdateWord,
  ): Promise<WordItem> {
    const pack = await this.packs.findEditable(user, packId);
    const word = await this.findInPack(pack.id, wordId);
    if (pack.shareCode) await this.assertClean(pack, [body]);

    const changes = {
      english: body.english,
      englishNorm: body.english === undefined ? undefined : englishKey(body.english),
      meanings: body.meanings,
      meaningsText: body.meanings === undefined ? undefined : meaningsText(body.meanings),
      ...extrasFor(pack, body),
    };
    if (Object.values(changes).some((value) => value !== undefined)) {
      try {
        await this.db.update(words).set(changes).where(eq(words.id, word.id));
      } catch (error) {
        if (isDuplicateKeyError(error, ACTIVE_ENGLISH_INDEX)) throw WordErrors.duplicate();
        throw error;
      }
    }
    const [item] = await this.viewer.items(user.userId, [await this.findInPack(pack.id, word.id)]);
    return item as WordItem;
  }

  async remove(user: AuthUser, packId: string, wordId: string): Promise<void> {
    const pack = await this.packs.findEditable(user, packId);
    await this.db.transaction(async (tx) => {
      const [result] = await tx
        .update(words)
        .set({ deletedAt: new Date() })
        .where(and(eq(words.id, wordId), eq(words.packId, pack.id), isNull(words.deletedAt)));
      if (result.affectedRows === 0) throw WordErrors.notFound();
      await tx
        .update(packs)
        .set({ wordCount: sql`GREATEST(${packs.wordCount} - 1, 0)` })
        .where(eq(packs.id, pack.id));
    });
  }

  private async findInPack(packId: string, wordId: string): Promise<Word> {
    const [word] = await this.db
      .select()
      .from(words)
      .where(and(eq(words.id, wordId), eq(words.packId, packId), isNull(words.deletedAt)));
    if (!word) throw WordErrors.notFound();
    return word;
  }

  /** 공유 중인 팩은 다른 사람이 보므로 단어도 금칙어 검사를 한다 */
  private async assertClean(pack: Pack, inputs: Partial<WordInput>[]): Promise<void> {
    for (const [index, input] of inputs.entries()) {
      const prefix = inputs.length > 1 ? `words[${index}].` : '';
      const fields: [string, string | null | undefined][] = [
        ['english', input.english],
        ...(input.meanings ?? []).map((value): [string, string] => ['meanings', value]),
      ];
      if (pack.type === 'DEFAULT') {
        fields.push(['example', input.example]);
        for (const value of input.derivatives ?? []) fields.push(['derivatives', value]);
      }
      // 매처가 공백을 지우므로 값을 이어 붙이지 않고 하나씩 검사한다 (경계를 넘는 오탐 방지)
      for (const [field, value] of fields) {
        await this.forbiddenWords.assertClean({ [`${prefix}${field}`]: value });
      }
    }
  }
}
