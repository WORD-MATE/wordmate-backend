import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import {
  type CursorPage,
  type CursorQuery,
  decodeCursor,
  toCursorPage,
} from '../../common/pagination.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { packs, wordFavorites, words } from '../../infra/db/schema/index.js';
import { toWordItem, visibleWords, WordErrors } from './word-common.js';
import type { WordWithPack } from './words.schemas.js';

const FavoriteCursor = z.object({ createdAt: z.iso.datetime(), wordId: z.uuid() });

@Injectable()
export class WordFavoritesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** 볼 수 없게 된 단어(삭제·남의 팩)의 즐겨찾기는 목록에서 뺀다 */
  async list(user: AuthUser, query: CursorQuery): Promise<CursorPage<WordWithPack>> {
    const cursor = query.cursor && decodeCursor(query.cursor, FavoriteCursor);
    const cursorAt = cursor ? new Date(cursor.createdAt) : null;
    const rows = await this.db
      .select({
        word: words,
        pack: { packId: packs.id, name: packs.name, type: packs.type },
        createdAt: wordFavorites.createdAt,
      })
      .from(wordFavorites)
      .innerJoin(words, eq(words.id, wordFavorites.wordId))
      .innerJoin(packs, eq(packs.id, words.packId))
      .where(
        and(
          eq(wordFavorites.userId, user.userId),
          visibleWords(user.userId),
          cursor && cursorAt
            ? or(
                lt(wordFavorites.createdAt, cursorAt),
                and(eq(wordFavorites.createdAt, cursorAt), lt(wordFavorites.wordId, cursor.wordId)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(wordFavorites.createdAt), desc(wordFavorites.wordId))
      .limit(query.size + 1);
    const page = toCursorPage(rows, query.size, (last) => ({
      createdAt: last.createdAt.toISOString(),
      wordId: last.word.id,
    }));
    return {
      items: page.items.map((row) => ({ word: toWordItem(row.word, true), pack: row.pack })),
      nextCursor: page.nextCursor,
    };
  }

  /** 이미 즐겨찾기여도 성공. 기본 팩이나 내 팩의 단어만 */
  async add(user: AuthUser, wordId: string): Promise<void> {
    const [word] = await this.db
      .select({ id: words.id })
      .from(words)
      .innerJoin(packs, eq(packs.id, words.packId))
      .where(and(eq(words.id, wordId), visibleWords(user.userId)));
    if (!word) throw WordErrors.notFound();
    await this.db.insert(wordFavorites).ignore().values({ userId: user.userId, wordId: word.id });
  }

  /** 즐겨찾기가 아니거나 단어가 지워졌어도 성공 */
  async remove(user: AuthUser, wordId: string): Promise<void> {
    await this.db
      .delete(wordFavorites)
      .where(and(eq(wordFavorites.userId, user.userId), eq(wordFavorites.wordId, wordId)));
  }

  async favoriteIds(userId: string, wordIds: string[]): Promise<Set<string>> {
    if (wordIds.length === 0) return new Set();
    const rows = await this.db
      .select({ wordId: wordFavorites.wordId })
      .from(wordFavorites)
      .where(and(eq(wordFavorites.userId, userId), inArray(wordFavorites.wordId, wordIds)));
    return new Set(rows.map((row) => row.wordId));
  }
}
