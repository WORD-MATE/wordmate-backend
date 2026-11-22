import { z } from 'zod';
import { FORBIDDEN_WORD_TYPE } from '../../common/enums.js';
import { PageQuery, page } from '../../common/pagination.js';

const word = z.string().trim().min(1).max(50);

export const ForbiddenWordQuery = PageQuery.extend({
  type: z.enum(FORBIDDEN_WORD_TYPE).optional(),
  q: z.string().trim().min(1).max(50).optional().describe('포함 검색'),
});
export type ForbiddenWordQuery = z.infer<typeof ForbiddenWordQuery>;

export const ForbiddenWordItem = z
  .object({
    wordId: z.string(),
    type: z.enum(FORBIDDEN_WORD_TYPE).describe('FORBIDDEN 금칙어, ALLOWED 오탐 방지용 허용 단어'),
    word: z.string(),
    createdAt: z.iso.datetime(),
    createdBy: z.string().nullable().describe('등록한 관리자 이름 (시드는 null)'),
  })
  .meta({ id: 'ForbiddenWord' });
export type ForbiddenWordItem = z.infer<typeof ForbiddenWordItem>;
export const ForbiddenWordPage = page(ForbiddenWordItem).meta({ id: 'ForbiddenWordPage' });

export const CreateForbiddenWord = z
  .object({ type: z.enum(FORBIDDEN_WORD_TYPE), word })
  .meta({ id: 'CreateForbiddenWord' });
export type CreateForbiddenWord = z.infer<typeof CreateForbiddenWord>;

export const UpdateForbiddenWord = z.object({ word }).meta({ id: 'UpdateForbiddenWord' });

export const ForbiddenWordCreated = z
  .object({ wordId: z.string() })
  .meta({ id: 'ForbiddenWordCreated' });
