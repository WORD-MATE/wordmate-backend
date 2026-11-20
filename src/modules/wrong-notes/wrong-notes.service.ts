import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, exists, gte, inArray, isNull, lt, or, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { type CursorPage, decodeCursor, toCursorPage } from '../../common/pagination.js';
import { kstDayRange } from '../../common/time/kst.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import {
  packs,
  studyRecordItems,
  studyRecords,
  words,
  wrongNotes,
} from '../../infra/db/schema/index.js';
import { WordViewerService } from '../words/word-viewer.service.js';
import type { WordItem } from '../words/words.schemas.js';
import type { WrongNoteIds, WrongNoteItem, WrongNoteListQuery } from './wrong-notes.schemas.js';

const RecentCursor = z.object({ at: z.iso.datetime(), id: z.uuid() });
const CountCursor = z.object({ n: z.number().int(), id: z.uuid() });

@Injectable()
export class WrongNotesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly viewer: WordViewerService,
  ) {}

  /** 삭제된 단어의 오답은 다시 풀 수 없으므로 목록에서 뺀다 (팩만 삭제됐으면 pack=null로 보여준다) */
  async list(user: AuthUser, query: WrongNoteListQuery): Promise<CursorPage<WrongNoteItem>> {
    const conditions: (SQL | undefined)[] = [
      eq(wrongNotes.userId, user.userId),
      eq(wrongNotes.status, query.status),
      isNull(words.deletedAt),
      query.questionType ? eq(wrongNotes.questionType, query.questionType) : undefined,
      query.packId ? eq(wrongNotes.packId, query.packId) : undefined,
      query.source ? eq(wrongNotes.source, query.source) : undefined,
      query.from ? gte(wrongNotes.lastWrongAt, kstDayRange(query.from).start) : undefined,
      query.to ? lt(wrongNotes.lastWrongAt, kstDayRange(query.to).end) : undefined,
      query.recordId ? this.wrongInRecord(user.userId, query.recordId) : undefined,
    ];

    let cursorCondition: SQL | undefined;
    if (query.cursor && query.sort === 'MOST_WRONG') {
      const cursor = decodeCursor(query.cursor, CountCursor);
      cursorCondition = or(
        lt(wrongNotes.wrongCount, cursor.n),
        and(eq(wrongNotes.wrongCount, cursor.n), lt(wrongNotes.id, cursor.id)),
      );
    } else if (query.cursor) {
      const cursor = decodeCursor(query.cursor, RecentCursor);
      const at = new Date(cursor.at);
      cursorCondition = or(
        lt(wrongNotes.lastWrongAt, at),
        and(eq(wrongNotes.lastWrongAt, at), lt(wrongNotes.id, cursor.id)),
      );
    }

    const rows = await this.db
      .select({
        note: wrongNotes,
        word: words,
        pack: { packId: packs.id, name: packs.name, deletedAt: packs.deletedAt },
      })
      .from(wrongNotes)
      .innerJoin(words, eq(words.id, wrongNotes.wordId))
      .leftJoin(packs, eq(packs.id, wrongNotes.packId))
      .where(and(...conditions, cursorCondition))
      .orderBy(
        ...(query.sort === 'MOST_WRONG'
          ? [desc(wrongNotes.wrongCount), desc(wrongNotes.id)]
          : [desc(wrongNotes.lastWrongAt), desc(wrongNotes.id)]),
      )
      .limit(query.size + 1);

    const page = toCursorPage(rows, query.size, (last) =>
      query.sort === 'MOST_WRONG'
        ? { n: last.note.wrongCount, id: last.note.id }
        : { at: last.note.lastWrongAt.toISOString(), id: last.note.id },
    );
    const items = await this.viewer.items(
      user.userId,
      page.items.map((row) => row.word),
    );
    return {
      items: page.items.map((row, i) => ({
        wrongNoteId: row.note.id,
        word: items[i] as WordItem,
        pack:
          row.pack && !row.pack.deletedAt ? { packId: row.pack.packId, name: row.pack.name } : null,
        questionType: row.note.questionType,
        source: row.note.source,
        wrongCount: row.note.wrongCount,
        consecutiveCorrect: row.note.consecutiveCorrect,
        lastWrongAt: row.note.lastWrongAt.toISOString(),
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** 남의 오답 id는 조용히 무시한다 */
  async remove(user: AuthUser, body: WrongNoteIds): Promise<{ deleted: number }> {
    const [result] = await this.db
      .delete(wrongNotes)
      .where(and(eq(wrongNotes.userId, user.userId), inArray(wrongNotes.id, body.wrongNoteIds)));
    return { deleted: result.affectedRows };
  }

  /** 수동 졸업: 목록에서 숨기고 기록은 보관한다. 이미 졸업한 것은 세지 않는다 */
  async graduate(user: AuthUser, body: WrongNoteIds): Promise<{ graduated: number }> {
    const [result] = await this.db
      .update(wrongNotes)
      .set({ status: 'GRADUATED', graduatedAt: new Date() })
      .where(
        and(
          eq(wrongNotes.userId, user.userId),
          eq(wrongNotes.status, 'ACTIVE'),
          inArray(wrongNotes.id, body.wrongNoteIds),
        ),
      );
    return { graduated: result.affectedRows };
  }

  /** 그 기록에서 같은 단어·같은 문제 유형으로 틀린 오답 (남의 기록이면 아무것도 걸리지 않는다) */
  private wrongInRecord(userId: string, recordId: string): SQL {
    return exists(
      this.db
        .select({ one: studyRecordItems.idx })
        .from(studyRecordItems)
        .innerJoin(studyRecords, eq(studyRecords.id, studyRecordItems.recordId))
        .where(
          and(
            eq(studyRecordItems.recordId, recordId),
            eq(studyRecords.userId, userId),
            eq(studyRecordItems.correct, false),
            eq(studyRecordItems.wordId, wrongNotes.wordId),
            eq(studyRecordItems.questionType, wrongNotes.questionType),
          ),
        ),
    );
  }
}
