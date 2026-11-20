import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, gt, like, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { type CursorPage, decodeCursor, toCursorPage } from '../../common/pagination.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { packs, words } from '../../infra/db/schema/index.js';
import { toWordItem, visibleWords } from './word-common.js';
import { WordFavoritesService } from './word-favorites.service.js';
import { containsPattern, fulltextQuery } from './word-text.js';
import type { WordSearchQuery, WordWithPack } from './words.schemas.js';

const SearchCursor = z.object({ english: z.string(), id: z.uuid() });

@Injectable()
export class WordSearchService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly favorites: WordFavoritesService,
  ) {}

  /**
   * 기본 팩 + 내 팩에서 영어나 뜻에 검색어가 들어 있는 단어. 영어 알파벳순.
   * FULLTEXT(ngram)로 후보를 좁히고 LIKE로 정확히 거른다 (1글자 낱말·띄어쓰기가 있는 검색어도 맞게)
   */
  async search(user: AuthUser, query: WordSearchQuery): Promise<CursorPage<WordWithPack>> {
    const cursor = query.cursor && decodeCursor(query.cursor, SearchCursor);
    const fulltext = fulltextQuery(query.q);
    const pattern = containsPattern(query.q);
    const rows = await this.db
      .select({ word: words, pack: { packId: packs.id, name: packs.name, type: packs.type } })
      .from(words)
      .innerJoin(packs, eq(packs.id, words.packId))
      .where(
        and(
          visibleWords(user.userId),
          fulltext
            ? sql`MATCH (${words.english}, ${words.meaningsText}) AGAINST (${fulltext} IN BOOLEAN MODE)`
            : undefined,
          or(like(words.english, pattern), like(words.meaningsText, pattern)),
          cursor
            ? or(
                gt(words.english, cursor.english),
                and(eq(words.english, cursor.english), gt(words.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(asc(words.english), asc(words.id))
      .limit(query.size + 1);
    const page = toCursorPage(rows, query.size, (last) => ({
      english: last.word.english,
      id: last.word.id,
    }));
    const favoriteIds = await this.favorites.favoriteIds(
      user.userId,
      page.items.map((row) => row.word.id),
    );
    return {
      items: page.items.map((row) => ({
        word: toWordItem(row.word, favoriteIds.has(row.word.id)),
        pack: row.pack,
      })),
      nextCursor: page.nextCursor,
    };
  }
}
