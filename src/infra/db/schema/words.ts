import { sql } from 'drizzle-orm';
import { index, json, mysqlTable, primaryKey, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';
import { id, softDelete, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { packs } from './packs.js';
import { users } from './users.js';

export const words = mysqlTable(
  'words',
  {
    id: id(),
    // active_english_key의 기반 컬럼이라 CASCADE 불가 (팩은 소프트 삭제)
    packId: binaryUuid('pack_id')
      .notNull()
      .references(() => packs.id),
    english: varchar('english', { length: 50 }).notNull(),
    // 서버 기본 collation(ai_ci)은 악센트를 무시하므로 중복 판정은 앱이 소문자로 만든 값을 bin으로 비교한다
    englishNorm: varchar('english_norm', { length: 50 }).collate('utf8mb4_bin').notNull(),
    meanings: json('meanings').$type<string[]>().notNull(),
    // JSON에는 FULLTEXT를 걸 수 없어 뜻을 이어 붙여 둔다. FULLTEXT(english, meanings_text)는 Drizzle이 지원하지 않아 마이그레이션 SQL에만 있다
    meaningsText: varchar('meanings_text', { length: 600 }).notNull().default(''),
    example: varchar('example', { length: 300 }),
    derivatives: json('derivatives')
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    activeEnglishKey: varchar('active_english_key', { length: 100 })
      .collate('utf8mb4_bin')
      .generatedAlwaysAs(
        sql`IF(deleted_at IS NULL, CONCAT(HEX(pack_id), ':', english_norm), NULL)`,
        { mode: 'stored' },
      ),
    ...softDelete,
    ...timestamps,
  },
  (t) => [
    uniqueIndex('words_active_english_uq').on(t.activeEnglishKey),
    index('words_pack_idx').on(t.packId, t.deletedAt, t.id),
  ],
);

export type Word = typeof words.$inferSelect;

export const wordFavorites = mysqlTable(
  'word_favorites',
  {
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    wordId: binaryUuid('word_id')
      .notNull()
      .references(() => words.id, { onDelete: 'cascade' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.wordId] }),
    index('word_favorites_user_created_idx').on(t.userId, t.createdAt, t.wordId),
  ],
);
