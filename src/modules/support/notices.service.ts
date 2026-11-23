import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { and, count, desc, eq, isNull, lt, or } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AuditLogService } from '../../common/audit/audit-log.service.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException } from '../../common/errors/app-exception.js';
import {
  type CursorPage,
  type CursorQuery,
  decodeCursor,
  type Page,
  type PageQuery,
  toCursorPage,
} from '../../common/pagination.js';
import { type Database, DB, type Transaction } from '../../infra/db/db.module.js';
import { type Notice, noticeReads, notices, users } from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type {
  AdminNoticeItem,
  CreateNotice,
  NoticeListItem,
  UpdateNotice,
} from './notices.schemas.js';

const NoticeCursor = z.object({ p: z.boolean(), id: z.uuid() });

export const NoticeErrors = {
  notFound: () =>
    new AppException('NOTICE_NOT_FOUND', '공지를 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
};

const visible = and(eq(notices.published, true), isNull(notices.deletedAt));

@Injectable()
export class NoticesService {
  private readonly logger = new Logger(NoticesService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly audit: AuditLogService,
    private readonly notifications: NotificationsService,
  ) {}

  /** 고정 공지 먼저, 그다음 최신순 */
  async list(user: AuthUser, query: CursorQuery): Promise<CursorPage<NoticeListItem>> {
    const cursor = query.cursor ? decodeCursor(query.cursor, NoticeCursor) : null;
    const after = cursor
      ? or(
          lt(notices.pinned, cursor.p),
          and(eq(notices.pinned, cursor.p), lt(notices.id, cursor.id)),
        )
      : undefined;
    const rows = await this.db
      .select({ notice: notices, readAt: noticeReads.readAt })
      .from(notices)
      .leftJoin(
        noticeReads,
        and(eq(noticeReads.noticeId, notices.id), eq(noticeReads.userId, user.userId)),
      )
      .where(and(visible, after))
      .orderBy(desc(notices.pinned), desc(notices.id))
      .limit(query.size + 1);
    const page = toCursorPage(rows, query.size, (last) => ({
      p: last.notice.pinned,
      id: last.notice.id,
    }));
    return {
      items: page.items.map(({ notice, readAt }) => ({
        noticeId: notice.id,
        title: notice.title,
        pinned: notice.pinned,
        read: readAt !== null,
        createdAt: notice.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** 열면 읽음으로 표시한다 */
  async detail(user: AuthUser, noticeId: string) {
    const [notice] = await this.db
      .select()
      .from(notices)
      .where(and(eq(notices.id, noticeId), visible));
    if (!notice) throw NoticeErrors.notFound();
    await this.db
      .insert(noticeReads)
      .ignore()
      .values({ userId: user.userId, noticeId, readAt: new Date() });
    return {
      noticeId: notice.id,
      title: notice.title,
      content: notice.content,
      pinned: notice.pinned,
      createdAt: notice.createdAt.toISOString(),
      updatedAt: notice.updatedAt.toISOString(),
    };
  }

  /** 관리자: 초안 포함, 지운 공지 제외, 최신순 */
  async adminList(query: PageQuery): Promise<Page<AdminNoticeItem>> {
    const where = isNull(notices.deletedAt);
    const [total] = await this.db.select({ value: count() }).from(notices).where(where);
    const rows = await this.db
      .select({ notice: notices, adminName: users.name })
      .from(notices)
      .leftJoin(users, eq(users.id, notices.createdBy))
      .where(where)
      .orderBy(desc(notices.id))
      .limit(query.size)
      .offset(query.page * query.size);
    return {
      totalCount: total?.value ?? 0,
      items: rows.map(({ notice, adminName }) => ({
        noticeId: notice.id,
        title: notice.title,
        pinned: notice.pinned,
        published: notice.published,
        createdBy: adminName,
        createdAt: notice.createdAt.toISOString(),
        updatedAt: notice.updatedAt.toISOString(),
      })),
    };
  }

  async create(admin: AuthUser, body: CreateNotice, request: FastifyRequest) {
    const noticeId = newId();
    await this.db.transaction(async (tx) => {
      await tx.insert(notices).values({
        id: noticeId,
        title: body.title,
        content: body.content,
        pinned: body.pinned,
        published: body.published,
        createdBy: admin.userId,
      });
      await this.record(
        admin,
        'NOTICE_CREATE',
        noticeId,
        // 초안에는 보내지 않으므로 실제로 보냈는지를 남긴다
        { title: body.title, published: body.published, sendPush: body.sendPush && body.published },
        request,
        tx,
      );
    });
    if (body.sendPush && body.published) {
      await this.broadcast({ id: noticeId, title: body.title });
    }
    return { noticeId };
  }

  async update(admin: AuthUser, noticeId: string, body: UpdateNotice, request: FastifyRequest) {
    await this.db.transaction(async (tx) => {
      await this.lockNotice(tx, noticeId);
      await tx
        .update(notices)
        .set({
          title: body.title,
          content: body.content,
          pinned: body.pinned,
          published: body.published,
        })
        .where(eq(notices.id, noticeId));
      await this.record(admin, 'NOTICE_UPDATE', noticeId, { ...body }, request, tx);
    });
  }

  async remove(admin: AuthUser, noticeId: string, request: FastifyRequest) {
    await this.db.transaction(async (tx) => {
      const notice = await this.lockNotice(tx, noticeId);
      await tx.update(notices).set({ deletedAt: new Date() }).where(eq(notices.id, noticeId));
      await this.record(admin, 'NOTICE_DELETE', noticeId, { title: notice.title }, request, tx);
    });
  }

  /** 활동 중인 모든 사용자에게. 공지 알림을 끈 사람은 알림 설정에서 걸러진다 */
  private async broadcast(notice: Pick<Notice, 'id' | 'title'>): Promise<void> {
    try {
      const active = await this.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.status, 'ACTIVE'));
      await this.notifications.notify(
        active.map((u) => u.id),
        {
          type: 'NOTICE',
          title: '새 공지',
          body: notice.title,
          route: `/notices/${notice.id}`,
        },
      );
    } catch (error) {
      this.logger.warn(`공지 알림 실패 (${notice.id}): ${String(error)}`);
    }
  }

  private async lockNotice(tx: Transaction, noticeId: string): Promise<Notice> {
    const [notice] = await tx
      .select()
      .from(notices)
      .where(and(eq(notices.id, noticeId), isNull(notices.deletedAt)))
      .for('update');
    if (!notice) throw NoticeErrors.notFound();
    return notice;
  }

  private record(
    admin: AuthUser,
    action: 'NOTICE_CREATE' | 'NOTICE_UPDATE' | 'NOTICE_DELETE',
    noticeId: string,
    detail: Record<string, unknown>,
    request: FastifyRequest,
    tx: Transaction,
  ) {
    return this.audit.record(
      { actorId: admin.userId, action, targetType: 'NOTICE', targetId: noticeId, detail },
      request,
      tx,
    );
  }
}
