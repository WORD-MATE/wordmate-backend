import { sql } from 'drizzle-orm';
import {
  type AnyMySqlColumn,
  char,
  datetime,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/mysql-core';
import { FORBIDDEN_WORD_TYPE, PACK_TYPE } from '../../../common/enums.js';
import { id, softDelete, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { users } from './users.js';

export const packCategories = mysqlTable('pack_categories', {
  id: id(),
  name: varchar('name', { length: 30 }).notNull(),
  sortOrder: int('sort_order').notNull().default(0),
  createdAt: timestamps.createdAt,
});

export const packs = mysqlTable(
  'packs',
  {
    id: id(),
    type: mysqlEnum('type', PACK_TYPE).notNull(),
    // active_name_key의 기반 컬럼이라 MySQL이 CASCADE를 허용하지 않는다 (사용자는 삭제하지 않고 익명화)
    ownerUserId: binaryUuid('owner_user_id').references(() => users.id),
    name: varchar('name', { length: 30 }).notNull(),
    description: varchar('description', { length: 200 }),
    categoryId: binaryUuid('category_id').references(() => packCategories.id, {
      onDelete: 'set null',
    }),
    sortOrder: int('sort_order').notNull().default(0),
    wordCount: int('word_count').notNull().default(0),
    copiedFromPackId: binaryUuid('copied_from_pack_id').references((): AnyMySqlColumn => packs.id, {
      onDelete: 'set null',
    }),
    shareCode: char('share_code', { length: 12 }).unique(),
    sharedAt: datetime('shared_at', { mode: 'date', fsp: 3 }),
    // 삭제되지 않은 내 단어팩끼리만 이름이 겹치지 않게 한다 (기본 팩·삭제된 팩은 NULL이라 제외)
    activeNameKey: varchar('active_name_key', { length: 64 }).generatedAlwaysAs(
      sql`IF(deleted_at IS NULL AND type = 'MINE', CONCAT(HEX(owner_user_id), ':', name), NULL)`,
      { mode: 'stored' },
    ),
    ...softDelete,
    ...timestamps,
  },
  (t) => [
    uniqueIndex('packs_active_name_uq').on(t.activeNameKey),
    index('packs_type_category_idx').on(t.type, t.categoryId),
    index('packs_owner_idx').on(t.ownerUserId, t.deletedAt, t.updatedAt),
  ],
);

export const forbiddenWords = mysqlTable(
  'forbidden_words',
  {
    id: id(),
    word: varchar('word', { length: 50 }).notNull(),
    type: mysqlEnum('type', FORBIDDEN_WORD_TYPE).notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [uniqueIndex('forbidden_words_word_type_uq').on(t.word, t.type)],
);

// 같은 공유 팩은 사용자당 한 번만 복사 (복사본을 지우면 copied_pack_id를 새 복사본으로 바꿔 다시 허용)
export const packCopies = mysqlTable(
  'pack_copies',
  {
    userId: binaryUuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourcePackId: binaryUuid('source_pack_id')
      .notNull()
      .references(() => packs.id, { onDelete: 'cascade' }),
    copiedPackId: binaryUuid('copied_pack_id')
      .notNull()
      .references(() => packs.id, { onDelete: 'cascade' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [primaryKey({ columns: [t.userId, t.sourcePackId] })],
);

export type Pack = typeof packs.$inferSelect;
