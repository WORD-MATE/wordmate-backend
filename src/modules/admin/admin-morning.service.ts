import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, lte, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { AuditLogService } from '../../common/audit/audit-log.service.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import type { AuditAction } from '../../common/enums.js';
import { AppException } from '../../common/errors/app-exception.js';
import type { Page } from '../../common/pagination.js';
import { type Database, DB, type Transaction } from '../../infra/db/db.module.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import {
  type MorningSentenceRow,
  morningKeywords,
  morningQuizzes,
  morningSentences,
  users,
} from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { MorningErrors } from '../morning/morning.service.js';
import {
  type ContentIssue,
  contentIssues,
  type MorningContent,
  replaceContent,
  withHighlights,
} from '../morning/morning-content.js';
import { morningDate } from '../morning/morning-rules.js';
import type {
  AdminMorningDetail,
  AdminMorningItem,
  AdminMorningQuery,
  CreateAdminMorning,
  UpdateAdminMorning,
} from './admin-morning.schemas.js';

const DATE_INDEX = 'publish_date_unique';

export const AdminMorningErrors = {
  dateExists: () =>
    new AppException('MORNING_DATE_EXISTS', '그 날짜에 이미 문장이 있습니다.', HttpStatus.CONFLICT),
  published: () =>
    new AppException(
      'MORNING_ALREADY_PUBLISHED',
      '게시된 문장은 날짜를 바꾸거나 교체할 수 없습니다. 게시를 취소한 뒤 바꿔 주세요.',
      HttpStatus.CONFLICT,
    ),
  /** 처음 걸린 문제의 코드로 답하고, 문제 목록은 detail에 담는다 */
  invalid: (issues: ContentIssue[]) => {
    const first =
      issues.find((i) => i.code === 'MORNING_INCOMPLETE') ??
      issues.find((i) => i.code === 'MORNING_BLANK_NOT_IN_SENTENCE') ??
      (issues[0] as ContentIssue);
    return new AppException(first.code, first.message, HttpStatus.BAD_REQUEST, {
      issues: issues.map((i) => ({ code: i.code, path: i.path.join('.'), message: i.message })),
    });
  },
};

@Injectable()
export class AdminMorningService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditLogService,
  ) {}

  /** 날짜 최신순 */
  async list(query: AdminMorningQuery): Promise<Page<AdminMorningItem>> {
    const conditions: (SQL | undefined)[] = [
      query.status ? eq(morningSentences.status, query.status) : undefined,
      query.from ? gte(morningSentences.publishDate, query.from) : undefined,
      query.to ? lte(morningSentences.publishDate, query.to) : undefined,
    ];
    const where = and(...conditions);
    const [total] = await this.db.select({ value: count() }).from(morningSentences).where(where);
    const rows = await this.db
      .select()
      .from(morningSentences)
      .where(where)
      .orderBy(desc(morningSentences.publishDate))
      .limit(query.size)
      .offset(query.page * query.size);
    return {
      totalCount: total?.value ?? 0,
      items: rows.map((row) => ({
        morningId: row.id,
        date: row.publishDate,
        sentence: row.sentence,
        status: row.status,
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  async detail(morningId: string): Promise<AdminMorningDetail> {
    const [row] = await this.db
      .select({ sentence: morningSentences, adminName: users.name })
      .from(morningSentences)
      .leftJoin(users, eq(users.id, morningSentences.updatedBy))
      .where(eq(morningSentences.id, morningId));
    if (!row) throw MorningErrors.notFound();
    const content = await this.contentOf(this.db, row.sentence);
    return {
      morningId: row.sentence.id,
      status: row.sentence.status,
      date: row.sentence.publishDate,
      sentence: content.sentence,
      translation: content.translation,
      keywords: content.keywords.map((k) => ({
        english: k.english,
        meanings: k.meanings,
        example: k.example ?? null,
        highlight: k.highlight,
      })),
      quizzes: content.quizzes.map((q) => ({
        type: q.type,
        question: q.question,
        choices: q.choices ?? null,
        answers: q.answers,
        explanation: q.explanation ?? null,
      })),
      updatedAt: row.sentence.updatedAt.toISOString(),
      updatedBy: row.adminName,
    };
  }

  /** 검수 대기로 등록한다. 핵심 어휘·퀴즈는 비어 있어도 되고 게시할 때 검사한다 */
  async create(admin: AuthUser, body: CreateAdminMorning, request: FastifyRequest) {
    const keywords = withHighlights(body.sentence, body.keywords);
    try {
      const morningId = await this.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(morningSentences)
          .where(eq(morningSentences.publishDate, body.date))
          .for('update');
        if (existing && !body.replace) throw AdminMorningErrors.dateExists();
        if (existing?.status === 'PUBLISHED') throw AdminMorningErrors.published();
        const id = existing?.id ?? newId();
        if (existing) {
          await tx
            .update(morningSentences)
            .set({
              sentence: body.sentence,
              translation: body.translation,
              status: 'PENDING_REVIEW',
              updatedBy: admin.userId,
            })
            .where(eq(morningSentences.id, id));
        } else {
          await tx.insert(morningSentences).values({
            id,
            publishDate: body.date,
            status: 'PENDING_REVIEW',
            sentence: body.sentence,
            translation: body.translation,
            updatedBy: admin.userId,
          });
        }
        await replaceContent(tx, id, keywords, body.quizzes);
        await this.record(
          tx,
          admin,
          'MORNING_CREATE',
          id,
          { date: body.date, replaced: Boolean(existing) },
          request,
        );
        return id;
      });
      return { morningId, status: 'PENDING_REVIEW' as const };
    } catch (error) {
      if (isDuplicateKeyError(error, DATE_INDEX)) throw AdminMorningErrors.dateExists();
      throw error;
    }
  }

  /**
   * 보낸 항목만 바꾼다(어휘·퀴즈는 통째로). 예약·게시된 문장은 바꾼 뒤에도 게시할 수 있는 상태여야 하고,
   * 게시된 문장은 날짜를 바꿀 수 없다. 이미 푼 사용자의 기록(정답 수)은 그대로다
   */
  async update(
    admin: AuthUser,
    morningId: string,
    body: UpdateAdminMorning,
    request: FastifyRequest,
  ): Promise<void> {
    try {
      await this.db.transaction(async (tx) => {
        const row = await this.lock(tx, morningId);
        if (body.date && body.date !== row.publishDate && row.status === 'PUBLISHED') {
          throw AdminMorningErrors.published();
        }
        const current = await this.contentOf(tx, row);
        const sentence = body.sentence ?? current.sentence;
        const next: MorningContent = {
          sentence,
          translation: body.translation ?? current.translation,
          keywords: body.keywords ? withHighlights(sentence, body.keywords) : current.keywords,
          quizzes: body.quizzes ?? current.quizzes,
        };
        if (row.status !== 'PENDING_REVIEW') {
          const issues = contentIssues(next);
          if (issues.length > 0) throw AdminMorningErrors.invalid(issues);
        }
        await tx
          .update(morningSentences)
          .set({
            publishDate: body.date,
            sentence: body.sentence,
            translation: body.translation,
            updatedBy: admin.userId,
          })
          .where(eq(morningSentences.id, morningId));
        if (body.keywords || body.quizzes) {
          await replaceContent(tx, morningId, next.keywords, next.quizzes);
        }
        await this.record(
          tx,
          admin,
          'MORNING_UPDATE',
          morningId,
          { fields: Object.keys(body) },
          request,
        );
      });
    } catch (error) {
      if (isDuplicateKeyError(error, DATE_INDEX)) throw AdminMorningErrors.dateExists();
      throw error;
    }
  }

  /** 게시 예약. 날짜가 이미 오늘(06:00 기준) 이전이면 바로 게시한다 */
  async publish(admin: AuthUser, morningId: string, request: FastifyRequest): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, morningId);
      if (row.status === 'PUBLISHED') return;
      const issues = contentIssues(await this.contentOf(tx, row));
      if (issues.length > 0) throw AdminMorningErrors.invalid(issues);
      const status = row.publishDate <= morningDate() ? 'PUBLISHED' : 'SCHEDULED';
      await tx
        .update(morningSentences)
        .set({ status, updatedBy: admin.userId })
        .where(eq(morningSentences.id, morningId));
      await this.record(tx, admin, 'MORNING_PUBLISH', morningId, { status }, request);
    });
  }

  /** 예약·게시를 취소해 검수 대기로 돌린다 (게시된 문장은 앱에서 사라진다) */
  async unpublish(admin: AuthUser, morningId: string, request: FastifyRequest): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.lock(tx, morningId);
      if (row.status === 'PENDING_REVIEW') return;
      await tx
        .update(morningSentences)
        .set({ status: 'PENDING_REVIEW', updatedBy: admin.userId })
        .where(eq(morningSentences.id, morningId));
      await this.record(tx, admin, 'MORNING_UNPUBLISH', morningId, { from: row.status }, request);
    });
  }

  private async lock(tx: Transaction, morningId: string): Promise<MorningSentenceRow> {
    const [row] = await tx
      .select()
      .from(morningSentences)
      .where(eq(morningSentences.id, morningId))
      .for('update');
    if (!row) throw MorningErrors.notFound();
    return row;
  }

  private async contentOf(
    executor: Database | Transaction,
    row: MorningSentenceRow,
  ): Promise<MorningContent> {
    const [keywords, quizzes] = await Promise.all([
      executor
        .select()
        .from(morningKeywords)
        .where(eq(morningKeywords.sentenceId, row.id))
        .orderBy(asc(morningKeywords.idx)),
      executor
        .select()
        .from(morningQuizzes)
        .where(eq(morningQuizzes.sentenceId, row.id))
        .orderBy(asc(morningQuizzes.idx)),
    ]);
    return {
      sentence: row.sentence,
      translation: row.translation,
      keywords: keywords.map((k) => ({
        english: k.english,
        meanings: k.meanings,
        example: k.example,
        highlight: { start: k.highlightStart, end: k.highlightEnd },
      })),
      quizzes: quizzes.map((q) => ({
        type: q.type,
        question: q.question,
        choices: q.choices,
        answers: q.answers,
        explanation: q.explanation,
      })),
    };
  }

  private record(
    tx: Transaction,
    admin: AuthUser,
    action: AuditAction,
    morningId: string,
    detail: Record<string, unknown>,
    request: FastifyRequest,
  ) {
    return this.audit.record(
      { actorId: admin.userId, action, targetType: 'MORNING', targetId: morningId, detail },
      request,
      tx,
    );
  }
}
