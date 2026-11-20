import { Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { MemoryStatus } from '../../common/enums.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { userWordProgress, type Word, wordFavorites } from '../../infra/db/schema/index.js';
import { toWordItem } from './word-common.js';
import type { WordItem } from './words.schemas.js';

/** 단어에 보는 사람 기준 정보(즐겨찾기, 암기 상태)를 붙인다 */
@Injectable()
export class WordViewerService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async items(userId: string, rows: Word[]): Promise<WordItem[]> {
    if (rows.length === 0) return [];
    const wordIds = rows.map((row) => row.id);
    const [favorites, progress] = await Promise.all([
      this.db
        .select({ wordId: wordFavorites.wordId })
        .from(wordFavorites)
        .where(and(eq(wordFavorites.userId, userId), inArray(wordFavorites.wordId, wordIds))),
      this.db
        .select({ wordId: userWordProgress.wordId, memoryStatus: userWordProgress.memoryStatus })
        .from(userWordProgress)
        .where(and(eq(userWordProgress.userId, userId), inArray(userWordProgress.wordId, wordIds))),
    ]);
    const favoriteIds = new Set(favorites.map((row) => row.wordId));
    const statuses = new Map<string, MemoryStatus>(
      progress.map((row) => [row.wordId, row.memoryStatus]),
    );
    return rows.map((row) =>
      toWordItem(row, favoriteIds.has(row.id), statuses.get(row.id) ?? 'NEW'),
    );
  }
}
