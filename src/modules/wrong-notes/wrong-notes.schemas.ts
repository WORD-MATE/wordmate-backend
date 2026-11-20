import { z } from 'zod';
import { QUESTION_TYPE, WRONG_NOTE_STATUS, WRONG_SORT, WRONG_SOURCE } from '../../common/enums.js';
import { CursorQuery, cursorPage } from '../../common/pagination.js';
import { WordItem } from '../words/words.schemas.js';

export const MAX_BULK_WRONG_NOTES = 500;

const kstDay = z.iso.date().describe('KST 날짜, 마지막으로 틀린 날 기준');

export const WrongNoteListQuery = CursorQuery.extend({
  status: z.enum(WRONG_NOTE_STATUS).default('ACTIVE'),
  questionType: z.enum(QUESTION_TYPE).optional(),
  packId: z.uuid().optional(),
  source: z.enum(WRONG_SOURCE).optional(),
  from: kstDay.optional(),
  to: kstDay.optional(),
  recordId: z.uuid().optional().describe('그 학습 기록에서 틀린 것만'),
  sort: z.enum(WRONG_SORT).default('RECENT'),
}).refine((query) => !query.from || !query.to || query.from <= query.to, {
  message: 'from은 to보다 늦을 수 없습니다.',
  path: ['from'],
});
export type WrongNoteListQuery = z.infer<typeof WrongNoteListQuery>;

export const WrongNoteItem = z
  .object({
    wrongNoteId: z.string(),
    word: WordItem,
    pack: z
      .object({ packId: z.string(), name: z.string() })
      .nullable()
      .describe('단어팩이 삭제되면 null'),
    questionType: z.enum(QUESTION_TYPE),
    source: z.enum(WRONG_SOURCE),
    wrongCount: z.number().int(),
    consecutiveCorrect: z.number().int(),
    lastWrongAt: z.iso.datetime(),
  })
  .meta({ id: 'WrongNoteItem' });
export type WrongNoteItem = z.infer<typeof WrongNoteItem>;

export const WrongNotePage = cursorPage(WrongNoteItem).meta({ id: 'WrongNotePage' });

export const WrongNoteIds = z
  .object({
    wrongNoteIds: z.array(z.uuid()).min(1).max(MAX_BULK_WRONG_NOTES),
  })
  .meta({ id: 'WrongNoteIds' });
export type WrongNoteIds = z.infer<typeof WrongNoteIds>;

export const DeletedCount = z.object({ deleted: z.number().int() }).meta({ id: 'DeletedCount' });
export const GraduatedCount = z
  .object({ graduated: z.number().int() })
  .meta({ id: 'GraduatedCount' });
