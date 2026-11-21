import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, lt, or } from 'drizzle-orm';
import { z } from 'zod';
import type { XpSource } from '../../common/enums.js';
import {
  type CursorPage,
  type CursorQuery,
  decodeCursor,
  toCursorPage,
} from '../../common/pagination.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { xpLedger } from '../../infra/db/schema/index.js';
import type { XpHistoryItem } from './xp.schemas.js';

const XP_TITLES: Record<XpSource, string> = {
  STUDY: '단어 학습',
  PACK_COMPLETE: '단어팩 완주',
  BATTLE: '대결',
  MORNING: '오늘의 문장',
  MISSION: '미션',
  CHALLENGE: '오늘의 챌린지',
  WRONG_NOTE_REVIEW: '오답노트 복습',
  ADMIN_ADJUST: '관리자 조정',
};

const HistoryCursor = z.object({ at: z.iso.datetime(), id: z.uuid() });

@Injectable()
export class XpHistoryService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** 최신순. 하루 상한에 걸려 0이 된 지급도 보여준다 (blockedReason) */
  async list(userId: string, query: CursorQuery): Promise<CursorPage<XpHistoryItem>> {
    const cursor = query.cursor && decodeCursor(query.cursor, HistoryCursor);
    const at = cursor ? new Date(cursor.at) : null;
    const rows = await this.db
      .select()
      .from(xpLedger)
      .where(
        and(
          eq(xpLedger.userId, userId),
          cursor && at
            ? or(
                lt(xpLedger.createdAt, at),
                and(eq(xpLedger.createdAt, at), lt(xpLedger.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(xpLedger.createdAt), desc(xpLedger.id))
      .limit(query.size + 1);
    const page = toCursorPage(rows, query.size, (last) => ({
      at: last.createdAt.toISOString(),
      id: last.id,
    }));
    return {
      items: page.items.map((row) => ({
        xpLogId: row.id,
        source: row.source,
        title: XP_TITLES[row.source],
        amount: row.amount,
        blockedReason: row.blockedReason,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }
}
