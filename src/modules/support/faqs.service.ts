import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { asc, eq, max } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { AuditLogService } from '../../common/audit/audit-log.service.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import type { FaqCategory } from '../../common/enums.js';
import { AppException } from '../../common/errors/app-exception.js';
import { type Database, DB, type Transaction } from '../../infra/db/db.module.js';
import { faqs } from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import type { CreateFaq, UpdateFaq } from './faqs.schemas.js';

export const FaqErrors = {
  notFound: () =>
    new AppException('FAQ_NOT_FOUND', 'FAQ를 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
};

@Injectable()
export class FaqsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditLogService,
  ) {}

  /** 분류 순, 분류 안에서는 순서대로 */
  async list(category?: FaqCategory) {
    const rows = await this.db
      .select()
      .from(faqs)
      .where(category ? eq(faqs.category, category) : undefined)
      .orderBy(asc(faqs.category), asc(faqs.sortOrder), asc(faqs.id));
    return rows.map((row) => ({
      faqId: row.id,
      category: row.category,
      question: row.question,
      answer: row.answer,
    }));
  }

  /** 순서를 비우면 그 분류의 맨 뒤 */
  async create(admin: AuthUser, body: CreateFaq, request: FastifyRequest) {
    const faqId = newId();
    await this.db.transaction(async (tx) => {
      let sortOrder = body.order;
      if (sortOrder === undefined) {
        const [last] = await tx
          .select({ value: max(faqs.sortOrder) })
          .from(faqs)
          .where(eq(faqs.category, body.category));
        sortOrder = (last?.value ?? -1) + 1;
      }
      await tx.insert(faqs).values({
        id: faqId,
        category: body.category,
        question: body.question,
        answer: body.answer,
        sortOrder,
      });
      await this.record(
        admin,
        'FAQ_CREATE',
        faqId,
        { category: body.category, question: body.question },
        request,
        tx,
      );
    });
    return { faqId };
  }

  async update(admin: AuthUser, faqId: string, body: UpdateFaq, request: FastifyRequest) {
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(faqs).where(eq(faqs.id, faqId)).for('update');
      if (!before) throw FaqErrors.notFound();
      await tx
        .update(faqs)
        .set({
          category: body.category,
          question: body.question,
          answer: body.answer,
          sortOrder: body.order,
        })
        .where(eq(faqs.id, faqId));
      await this.record(admin, 'FAQ_UPDATE', faqId, { ...body }, request, tx);
    });
  }

  async remove(admin: AuthUser, faqId: string, request: FastifyRequest) {
    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(faqs).where(eq(faqs.id, faqId)).for('update');
      if (!before) throw FaqErrors.notFound();
      await tx.delete(faqs).where(eq(faqs.id, faqId));
      await this.record(admin, 'FAQ_DELETE', faqId, { question: before.question }, request, tx);
    });
  }

  private record(
    admin: AuthUser,
    action: 'FAQ_CREATE' | 'FAQ_UPDATE' | 'FAQ_DELETE',
    faqId: string,
    detail: Record<string, unknown>,
    request: FastifyRequest,
    tx: Transaction,
  ) {
    return this.audit.record(
      { actorId: admin.userId, action, targetType: 'FAQ', targetId: faqId, detail },
      request,
      tx,
    );
  }
}
