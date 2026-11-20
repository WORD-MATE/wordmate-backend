import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  like,
  lt,
  max,
  or,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException, CommonErrors } from '../../common/errors/app-exception.js';
import { type CursorPage, decodeCursor, toCursorPage } from '../../common/pagination.js';
import type { Env } from '../../config/env.js';
import { type Database, DB, type Transaction } from '../../infra/db/db.module.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import {
  type Pack,
  packCategories,
  packs,
  users,
  userWordProgress,
  words,
} from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { ForbiddenWordsService } from '../forbidden-words/forbidden-words.service.js';
import type { CreatePack, PackListQuery, PackSummary, UpdatePack } from './packs.schemas.js';

export const MAX_PACKS_PER_USER = 50;

export const PackErrors = {
  notFound: () =>
    new AppException('PACK_NOT_FOUND', '단어팩을 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
  nameDuplicate: () =>
    new AppException(
      'PACK_NAME_DUPLICATE',
      '같은 이름의 단어팩이 이미 있습니다.',
      HttpStatus.CONFLICT,
    ),
  limitExceeded: () =>
    new AppException(
      'PACK_LIMIT_EXCEEDED',
      `단어팩은 최대 ${MAX_PACKS_PER_USER}개까지 만들 수 있습니다.`,
      HttpStatus.CONFLICT,
      { limit: MAX_PACKS_PER_USER },
    ),
  categoryNotFound: () =>
    CommonErrors.invalidRequest({ field: 'categoryId' }, '존재하지 않는 분류입니다.'),
};

const ACTIVE_NAME_INDEX = 'packs_active_name_uq';

const SortOrderCursor = z.object({ s: z.number().int(), id: z.uuid() });
const NameCursor = z.object({ n: z.string(), id: z.uuid() });
const UpdatedCursor = z.object({ u: z.iso.datetime(), id: z.uuid() });

const escapeLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

export const canEdit = (user: AuthUser, pack: Pack): boolean =>
  pack.type === 'MINE' ? pack.ownerUserId === user.userId : user.isAdmin;

/** 이 사용자의 팩별 암기 진행 (삭제된 단어 제외). 진행 기록이 없는 단어는 NEW */
export type PackProgress = { learning: number; memorized: number; lastStudiedAt: Date | null };
const NO_PROGRESS: PackProgress = { learning: 0, memorized: 0, lastStudiedAt: null };

export function toPackSummary(pack: Pack, progress: PackProgress = NO_PROGRESS): PackSummary {
  return {
    packId: pack.id,
    type: pack.type,
    name: pack.name,
    description: pack.description,
    categoryId: pack.categoryId,
    wordCount: pack.wordCount,
    progress: {
      studied: Math.min(progress.learning + progress.memorized, pack.wordCount),
      total: pack.wordCount,
    },
    lastStudiedAt: progress.lastStudiedAt?.toISOString() ?? null,
    shared: pack.shareCode !== null,
  };
}

@Injectable()
export class PacksService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly forbiddenWords: ForbiddenWordsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  shareInfo(shareCode: string) {
    const base = this.config.get('SHARE_LINK_BASE', { infer: true }).replace(/\/$/, '');
    return { shareCode, url: `${base}/packs/shared/${shareCode}` };
  }

  /** 사용자 행을 잠가 동시에 만들어도 내 단어팩 한도를 넘지 않게 한다 (트랜잭션 안에서 호출) */
  async assertMinePackSlot(tx: Transaction, userId: string): Promise<void> {
    await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
    const [row] = await tx
      .select({ total: count() })
      .from(packs)
      .where(and(eq(packs.ownerUserId, userId), eq(packs.type, 'MINE'), isNull(packs.deletedAt)));
    if ((row?.total ?? 0) >= MAX_PACKS_PER_USER) throw PackErrors.limitExceeded();
  }

  categories() {
    return this.db
      .select({ categoryId: packCategories.id, name: packCategories.name })
      .from(packCategories)
      .orderBy(asc(packCategories.sortOrder), asc(packCategories.name));
  }

  async list(user: AuthUser, query: PackListQuery): Promise<CursorPage<PackSummary>> {
    const conditions: (SQL | undefined)[] = [eq(packs.type, query.type), isNull(packs.deletedAt)];
    if (query.type === 'MINE') conditions.push(eq(packs.ownerUserId, user.userId));
    if (query.categoryId) conditions.push(eq(packs.categoryId, query.categoryId));
    if (query.q) conditions.push(like(packs.name, `%${escapeLike(query.q)}%`));

    const limit = query.size + 1;
    const where = (cursorCondition?: SQL) => and(...conditions, cursorCondition);

    let rows: Pack[];
    let cursorOf: (last: Pack) => unknown;
    if (query.sort === 'NAME') {
      const cursor = query.cursor && decodeCursor(query.cursor, NameCursor);
      rows = await this.db
        .select()
        .from(packs)
        .where(
          where(
            cursor
              ? or(gt(packs.name, cursor.n), and(eq(packs.name, cursor.n), gt(packs.id, cursor.id)))
              : undefined,
          ),
        )
        .orderBy(asc(packs.name), asc(packs.id))
        .limit(limit);
      cursorOf = (last) => ({ n: last.name, id: last.id });
    } else if (query.sort === 'RECOMMENDED' && query.type === 'DEFAULT') {
      const cursor = query.cursor && decodeCursor(query.cursor, SortOrderCursor);
      rows = await this.db
        .select()
        .from(packs)
        .where(
          where(
            cursor
              ? or(
                  gt(packs.sortOrder, cursor.s),
                  and(eq(packs.sortOrder, cursor.s), gt(packs.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(asc(packs.sortOrder), asc(packs.id))
        .limit(limit);
      cursorOf = (last) => ({ s: last.sortOrder, id: last.id });
    } else {
      // 내 팩의 추천순, 최근순은 최근 수정순 (최근 학습순은 학습 기록이 생기면 바꾼다)
      const cursor = query.cursor && decodeCursor(query.cursor, UpdatedCursor);
      const updatedAt = cursor ? new Date(cursor.u) : undefined;
      rows = await this.db
        .select()
        .from(packs)
        .where(
          where(
            cursor && updatedAt
              ? or(
                  lt(packs.updatedAt, updatedAt),
                  and(eq(packs.updatedAt, updatedAt), lt(packs.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(packs.updatedAt), desc(packs.id))
        .limit(limit);
      cursorOf = (last) => ({ u: last.updatedAt.toISOString(), id: last.id });
    }

    const page = toCursorPage(rows, query.size, cursorOf);
    return { items: await this.summaries(user, page.items), nextCursor: page.nextCursor };
  }

  async detail(user: AuthUser, packId: string) {
    const pack = await this.findVisible(user, packId);
    const progress = (await this.progressOf(user.userId, [pack.id])).get(pack.id) ?? NO_PROGRESS;
    const LEARNING = Math.min(progress.learning, pack.wordCount);
    const MEMORIZED = Math.min(progress.memorized, pack.wordCount - LEARNING);
    return {
      ...toPackSummary(pack, progress),
      editable: canEdit(user, pack),
      memoryStatusCount: { NEW: pack.wordCount - LEARNING - MEMORIZED, LEARNING, MEMORIZED },
      share: pack.shareCode ? this.shareInfo(pack.shareCode) : null,
    };
  }

  async create(user: AuthUser, body: CreatePack): Promise<PackSummary> {
    if (body.type === 'DEFAULT' && !user.isAdmin) throw CommonErrors.forbidden();
    const categoryId = body.type === 'DEFAULT' ? (body.categoryId ?? null) : null;
    if (categoryId) await this.assertCategory(categoryId);
    await this.forbiddenWords.assertClean({ name: body.name, description: body.description });

    const id = newId();
    try {
      await this.db.transaction(async (tx) => {
        if (body.type === 'MINE') await this.assertMinePackSlot(tx, user.userId);
        await tx.insert(packs).values({
          id,
          type: body.type,
          ownerUserId: body.type === 'MINE' ? user.userId : null,
          name: body.name,
          description: body.description ?? null,
          categoryId,
        });
      });
    } catch (error) {
      if (isDuplicateKeyError(error, ACTIVE_NAME_INDEX)) throw PackErrors.nameDuplicate();
      throw error;
    }
    return toPackSummary(await this.findById(id));
  }

  async update(user: AuthUser, packId: string, body: UpdatePack): Promise<PackSummary> {
    const pack = await this.findEditable(user, packId);
    const categoryId = pack.type === 'DEFAULT' ? body.categoryId : undefined;
    if (categoryId) await this.assertCategory(categoryId);
    await this.forbiddenWords.assertClean({ name: body.name, description: body.description });

    try {
      await this.db
        .update(packs)
        .set({ name: body.name, description: body.description, categoryId })
        .where(eq(packs.id, pack.id));
    } catch (error) {
      if (isDuplicateKeyError(error, ACTIVE_NAME_INDEX)) throw PackErrors.nameDuplicate();
      throw error;
    }
    const [summary] = await this.summaries(user, [await this.findById(pack.id)]);
    return summary as PackSummary;
  }

  async summaries(user: AuthUser, rows: Pack[]): Promise<PackSummary[]> {
    const progress = await this.progressOf(
      user.userId,
      rows.map((row) => row.id),
    );
    return rows.map((row) => toPackSummary(row, progress.get(row.id)));
  }

  async progressOf(userId: string, packIds: string[]): Promise<Map<string, PackProgress>> {
    const result = new Map<string, PackProgress>();
    if (packIds.length === 0) return result;
    const rows = await this.db
      .select({
        packId: userWordProgress.packId,
        memoryStatus: userWordProgress.memoryStatus,
        total: count(),
        lastStudiedAt: max(userWordProgress.lastStudiedAt),
      })
      .from(userWordProgress)
      .innerJoin(words, eq(words.id, userWordProgress.wordId))
      .where(
        and(
          eq(userWordProgress.userId, userId),
          inArray(userWordProgress.packId, packIds),
          isNull(words.deletedAt),
        ),
      )
      .groupBy(userWordProgress.packId, userWordProgress.memoryStatus);
    for (const row of rows) {
      const progress = result.get(row.packId) ?? { ...NO_PROGRESS };
      if (row.memoryStatus === 'LEARNING') progress.learning += row.total;
      if (row.memoryStatus === 'MEMORIZED') progress.memorized += row.total;
      if (
        row.lastStudiedAt &&
        (!progress.lastStudiedAt || row.lastStudiedAt > progress.lastStudiedAt)
      ) {
        progress.lastStudiedAt = row.lastStudiedAt;
      }
      result.set(row.packId, progress);
    }
    return result;
  }

  async remove(user: AuthUser, packId: string): Promise<void> {
    const pack = await this.findEditable(user, packId);
    await this.db
      .update(packs)
      .set({ deletedAt: new Date(), shareCode: null, sharedAt: null })
      .where(eq(packs.id, pack.id));
  }

  async findVisible(user: AuthUser, packId: string): Promise<Pack> {
    const pack = await this.findById(packId);
    if (pack.type === 'MINE' && pack.ownerUserId !== user.userId) throw CommonErrors.forbidden();
    return pack;
  }

  async findEditable(user: AuthUser, packId: string): Promise<Pack> {
    const pack = await this.findVisible(user, packId);
    if (!canEdit(user, pack)) throw CommonErrors.forbidden();
    return pack;
  }

  async findById(packId: string): Promise<Pack> {
    const [pack] = await this.db
      .select()
      .from(packs)
      .where(and(eq(packs.id, packId), isNull(packs.deletedAt)));
    if (!pack) throw PackErrors.notFound();
    return pack;
  }

  private async assertCategory(categoryId: string): Promise<void> {
    const [category] = await this.db
      .select({ id: packCategories.id })
      .from(packCategories)
      .where(eq(packCategories.id, categoryId));
    if (!category) throw PackErrors.categoryNotFound();
  }
}
