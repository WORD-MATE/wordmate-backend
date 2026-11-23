import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, count, desc, eq, like, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { AuditLogService } from '../../common/audit/audit-log.service.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException } from '../../common/errors/app-exception.js';
import type { Page } from '../../common/pagination.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import { forbiddenWords, users } from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { ForbiddenWordsService } from '../forbidden-words/forbidden-words.service.js';
import type {
  CreateForbiddenWord,
  ForbiddenWordItem,
  ForbiddenWordQuery,
} from './admin-forbidden-words.schemas.js';

const UNIQUE_INDEX = 'forbidden_words_word_type_uq';

export const AdminForbiddenWordErrors = {
  notFound: () =>
    new AppException(
      'ADMIN_FORBIDDEN_WORD_NOT_FOUND',
      '금칙어를 찾을 수 없습니다.',
      HttpStatus.NOT_FOUND,
    ),
  duplicate: () =>
    new AppException(
      'ADMIN_FORBIDDEN_WORD_DUPLICATE',
      '이미 등록된 단어입니다.',
      HttpStatus.CONFLICT,
    ),
};

@Injectable()
export class AdminForbiddenWordsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditLogService,
    private readonly forbidden: ForbiddenWordsService,
  ) {}

  /** 최근 등록순 */
  async list(query: ForbiddenWordQuery): Promise<Page<ForbiddenWordItem>> {
    const keyword = query.q?.replace(/[%_\\]/g, (c) => `\\${c}`);
    const conditions: (SQL | undefined)[] = [
      query.type ? eq(forbiddenWords.type, query.type) : undefined,
      keyword ? like(forbiddenWords.word, `%${keyword}%`) : undefined,
    ];
    const where = and(...conditions);
    const [total] = await this.db.select({ value: count() }).from(forbiddenWords).where(where);
    const rows = await this.db
      .select({ word: forbiddenWords, adminName: users.name })
      .from(forbiddenWords)
      .leftJoin(users, eq(users.id, forbiddenWords.createdBy))
      .where(where)
      .orderBy(desc(forbiddenWords.id))
      .limit(query.size)
      .offset(query.page * query.size);
    return {
      totalCount: total?.value ?? 0,
      items: rows.map(({ word, adminName }) => ({
        wordId: word.id,
        type: word.type,
        word: word.word,
        createdAt: word.createdAt.toISOString(),
        createdBy: adminName,
      })),
    };
  }

  /** 바꾼 즉시 모든 서버의 검사에 반영된다 */
  async create(
    admin: AuthUser,
    body: CreateForbiddenWord,
    request: FastifyRequest,
  ): Promise<{ wordId: string }> {
    const wordId = newId();
    await this.write(async () => {
      await this.db.transaction(async (tx) => {
        await tx
          .insert(forbiddenWords)
          .values({ id: wordId, type: body.type, word: body.word, createdBy: admin.userId });
        await this.audit.record(
          {
            actorId: admin.userId,
            action: 'FORBIDDEN_WORD_CREATE',
            targetType: 'FORBIDDEN_WORD',
            targetId: wordId,
            detail: { type: body.type, word: body.word },
          },
          request,
          tx,
        );
      });
    });
    return { wordId };
  }

  async update(
    admin: AuthUser,
    wordId: string,
    word: string,
    request: FastifyRequest,
  ): Promise<void> {
    await this.write(async () => {
      await this.db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(forbiddenWords)
          .where(eq(forbiddenWords.id, wordId))
          .for('update');
        if (!before) throw AdminForbiddenWordErrors.notFound();
        await tx.update(forbiddenWords).set({ word }).where(eq(forbiddenWords.id, wordId));
        await this.audit.record(
          {
            actorId: admin.userId,
            action: 'FORBIDDEN_WORD_UPDATE',
            targetType: 'FORBIDDEN_WORD',
            targetId: wordId,
            detail: { type: before.type, before: before.word, after: word },
          },
          request,
          tx,
        );
      });
    });
  }

  async remove(admin: AuthUser, wordId: string, request: FastifyRequest): Promise<void> {
    await this.write(async () => {
      await this.db.transaction(async (tx) => {
        const [before] = await tx
          .select()
          .from(forbiddenWords)
          .where(eq(forbiddenWords.id, wordId))
          .for('update');
        if (!before) throw AdminForbiddenWordErrors.notFound();
        await tx.delete(forbiddenWords).where(eq(forbiddenWords.id, wordId));
        await this.audit.record(
          {
            actorId: admin.userId,
            action: 'FORBIDDEN_WORD_DELETE',
            targetType: 'FORBIDDEN_WORD',
            targetId: wordId,
            detail: { type: before.type, word: before.word },
          },
          request,
          tx,
        );
      });
    });
  }

  private async write(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (isDuplicateKeyError(error, UNIQUE_INDEX)) throw AdminForbiddenWordErrors.duplicate();
      throw error;
    }
    await this.forbidden.markChanged();
  }
}
