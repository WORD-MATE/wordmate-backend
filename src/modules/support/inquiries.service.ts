import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { and, asc, count, desc, eq, lt } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { AuditLogService } from '../../common/audit/audit-log.service.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import type { ClientInfo } from '../../common/client/client.guard.js';
import { AppException, CommonErrors } from '../../common/errors/app-exception.js';
import {
  type CursorPage,
  type CursorQuery,
  decodeCursor,
  type Page,
  toCursorPage,
} from '../../common/pagination.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { inquiries, inquiryImages, users } from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import type {
  AdminInquiryItem,
  AdminInquiryQuery,
  AnswerInquiry,
  InquiryDetail,
  InquiryListItem,
} from './inquiries.schemas.js';
import type { InquiryForm } from './inquiry-form.js';
import { sanitizeImage } from './inquiry-image.js';
import { InquiryImageStorage } from './inquiry-image.storage.js';

/** 한 사람이 이 시간 동안 남길 수 있는 문의 수 (임시값) */
export const INQUIRY_RATE_LIMIT = 5;
export const INQUIRY_RATE_WINDOW_SECONDS = 60 * 60;

const ListCursor = z.object({ id: z.uuid() });
const rateKey = (userId: string) => `inquiry:rate:${userId}`;

export const InquiryErrors = {
  notFound: () =>
    new AppException('INQUIRY_NOT_FOUND', '문의를 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
  tooFrequent: (retryAfterSeconds: number) =>
    new AppException(
      'INQUIRY_TOO_FREQUENT',
      '문의를 너무 자주 보냈습니다. 잠시 후 다시 시도해 주세요.',
      HttpStatus.TOO_MANY_REQUESTS,
      { retryAfterSeconds },
    ),
  imageUrlInvalid: () =>
    new AppException(
      'INQUIRY_IMAGE_URL_INVALID',
      '이미지 주소가 만료됐거나 올바르지 않습니다. 문의를 다시 열어 주세요.',
      HttpStatus.FORBIDDEN,
    ),
  imageNotFound: () =>
    new AppException('INQUIRY_IMAGE_NOT_FOUND', '이미지를 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
};

@Injectable()
export class InquiriesService {
  private readonly logger = new Logger(InquiriesService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(VALKEY) private readonly valkey: Redis,
    private readonly storage: InquiryImageStorage,
    private readonly audit: AuditLogService,
    private readonly notifications: NotificationsService,
  ) {}

  /** 본문을 읽고 이미지를 처리하기 전에, 이미 한도를 채운 사람은 먼저 돌려보낸다 */
  async assertNotTooFrequent(userId: string): Promise<void> {
    const [used, ttl] = await this.rateState(userId);
    if (used >= INQUIRY_RATE_LIMIT) throw InquiryErrors.tooFrequent(ttl);
  }

  async create(user: AuthUser, client: ClientInfo, form: InquiryForm) {
    const images: { id: string; key: string; data: Buffer; mime: string }[] = [];
    for (const [index, data] of form.images.entries()) {
      const id = newId();
      images.push({ id, key: this.storage.keyOf(id), ...(await sanitizeImage(data, index)) });
    }
    const counted = await this.takeSlot(user.userId);

    const inquiryId = newId();
    try {
      for (const image of images) await this.storage.save(image.key, image.data);
      await this.db.transaction(async (tx) => {
        await tx.insert(inquiries).values({
          id: inquiryId,
          userId: user.userId,
          type: form.body.type,
          title: form.body.title,
          content: form.body.content,
          platform: client.platform,
          appVersion: client.version.slice(0, 32),
        });
        if (images.length > 0) {
          await tx.insert(inquiryImages).values(
            images.map((image, i) => ({
              id: image.id,
              inquiryId,
              storageKey: image.key,
              mime: image.mime,
              size: image.data.length,
              sortOrder: i,
            })),
          );
        }
      });
    } catch (error) {
      await this.storage.remove(images.map((image) => image.key)).catch(() => {});
      if (counted) await this.valkey.decr(rateKey(user.userId)).catch(() => {});
      throw error;
    }
    return { inquiryId };
  }

  async list(user: AuthUser, query: CursorQuery): Promise<CursorPage<InquiryListItem>> {
    const cursor = query.cursor ? decodeCursor(query.cursor, ListCursor) : null;
    const rows = await this.db
      .select()
      .from(inquiries)
      .where(
        and(eq(inquiries.userId, user.userId), cursor ? lt(inquiries.id, cursor.id) : undefined),
      )
      .orderBy(desc(inquiries.id))
      .limit(query.size + 1);
    const page = toCursorPage(rows, query.size, (last) => ({ id: last.id }));
    return {
      items: page.items.map((row) => ({
        inquiryId: row.id,
        type: row.type,
        title: row.title,
        status: row.status,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** 본인 또는 관리자만. 이미지는 10분짜리 서명 주소로 내준다 */
  async detail(user: AuthUser, inquiryId: string, origin: string): Promise<InquiryDetail> {
    const [inquiry] = await this.db.select().from(inquiries).where(eq(inquiries.id, inquiryId));
    if (!inquiry) throw InquiryErrors.notFound();
    if (inquiry.userId !== user.userId && !user.isAdmin) throw CommonErrors.forbidden();
    const images = await this.db
      .select({ id: inquiryImages.id })
      .from(inquiryImages)
      .where(eq(inquiryImages.inquiryId, inquiryId))
      .orderBy(asc(inquiryImages.sortOrder));
    return {
      inquiryId: inquiry.id,
      type: inquiry.type,
      title: inquiry.title,
      content: inquiry.content,
      images: images.map((image) => ({
        imageId: image.id,
        url: `${origin}${this.storage.signedPath(image.id)}`,
      })),
      status: inquiry.status,
      answer:
        inquiry.answerContent !== null && inquiry.answeredAt !== null
          ? { content: inquiry.answerContent, answeredAt: inquiry.answeredAt.toISOString() }
          : null,
      createdAt: inquiry.createdAt.toISOString(),
    };
  }

  /** 서명이 권한이다. 서명이 맞으면 로그인 없이 내준다 */
  async image(imageId: string, exp: unknown, sig: unknown) {
    if (!this.storage.verify(imageId, exp, sig)) throw InquiryErrors.imageUrlInvalid();
    const [image] = await this.db
      .select({ storageKey: inquiryImages.storageKey, mime: inquiryImages.mime })
      .from(inquiryImages)
      .where(eq(inquiryImages.id, imageId));
    if (!image) throw InquiryErrors.imageNotFound();
    const data = await this.storage.read(image.storageKey);
    if (!data) throw InquiryErrors.imageNotFound();
    return { data, mime: image.mime };
  }

  /** 관리자: 최신순 */
  async adminList(query: AdminInquiryQuery): Promise<Page<AdminInquiryItem>> {
    const where = and(
      query.status ? eq(inquiries.status, query.status) : undefined,
      query.type ? eq(inquiries.type, query.type) : undefined,
    );
    const [total] = await this.db.select({ value: count() }).from(inquiries).where(where);
    const rows = await this.db
      .select({ inquiry: inquiries, userName: users.name })
      .from(inquiries)
      .innerJoin(users, eq(users.id, inquiries.userId))
      .where(where)
      .orderBy(desc(inquiries.id))
      .limit(query.size)
      .offset(query.page * query.size);
    return {
      totalCount: total?.value ?? 0,
      items: rows.map(({ inquiry, userName }) => ({
        inquiryId: inquiry.id,
        user: { userId: inquiry.userId, name: userName },
        type: inquiry.type,
        title: inquiry.title,
        status: inquiry.status,
        platform: inquiry.platform,
        appVersion: inquiry.appVersion,
        createdAt: inquiry.createdAt.toISOString(),
      })),
    };
  }

  /** 다시 호출하면 답변을 고친다. 알림은 처음 답할 때만 보낸다 */
  async answer(admin: AuthUser, inquiryId: string, body: AnswerInquiry, request: FastifyRequest) {
    const result = await this.db.transaction(async (tx) => {
      const [inquiry] = await tx
        .select()
        .from(inquiries)
        .where(eq(inquiries.id, inquiryId))
        .for('update');
      if (!inquiry) throw InquiryErrors.notFound();
      const first = inquiry.answeredAt === null;
      await tx
        .update(inquiries)
        .set({
          status: 'ANSWERED',
          answerContent: body.content,
          answeredBy: admin.userId,
          answeredAt: new Date(),
        })
        .where(eq(inquiries.id, inquiryId));
      await this.audit.record(
        {
          actorId: admin.userId,
          action: 'INQUIRY_ANSWER',
          targetType: 'INQUIRY',
          targetId: inquiryId,
          detail: { edited: !first },
        },
        request,
        tx,
      );
      return { first, userId: inquiry.userId, title: inquiry.title };
    });
    if (!result.first) return;
    try {
      await this.notifications.notify([result.userId], {
        type: 'INQUIRY_ANSWERED',
        title: '문의 답변',
        body: `"${result.title}" 문의에 답변이 달렸습니다.`,
        route: `/inquiries/${inquiryId}`,
      });
    } catch (error) {
      this.logger.warn(`문의 답변 알림 실패 (${inquiryId}): ${String(error)}`);
    }
  }

  private async rateState(userId: string): Promise<[used: number, ttl: number]> {
    try {
      const [used, ttl] = await Promise.all([
        this.valkey.get(rateKey(userId)),
        this.valkey.ttl(rateKey(userId)),
      ]);
      return [Number(used ?? 0), Math.max(ttl, 1)];
    } catch (error) {
      // Valkey 장애로 문의 자체를 막지는 않는다
      this.logger.warn(`문의 빈도 확인 실패: ${String(error)}`);
      return [0, 0];
    }
  }

  /** 첫 문의부터 한 시간 동안 센다. 동시에 보내도 한도를 넘지 않게 올린 뒤 확인한다 */
  private async takeSlot(userId: string): Promise<boolean> {
    try {
      const results = await this.valkey
        .multi()
        .incr(rateKey(userId))
        .expire(rateKey(userId), INQUIRY_RATE_WINDOW_SECONDS, 'NX')
        .ttl(rateKey(userId))
        .exec();
      const used = Number(results?.[0]?.[1] ?? 0);
      if (used > INQUIRY_RATE_LIMIT) {
        await this.valkey.decr(rateKey(userId));
        throw InquiryErrors.tooFrequent(Math.max(Number(results?.[2]?.[1] ?? 1), 1));
      }
      return true;
    } catch (error) {
      if (error instanceof AppException) throw error;
      this.logger.warn(`문의 빈도 기록 실패: ${String(error)}`);
      return false;
    }
  }
}
