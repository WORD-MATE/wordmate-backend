import { z } from 'zod';
import { PACK_SORT, PACK_TYPE } from '../../common/enums.js';
import { CursorQuery, cursorPage } from '../../common/pagination.js';
import { UserSummary } from '../users/user-summary.js';
import { WordItem } from '../words/words.schemas.js';

const packName = z.string().trim().min(1, '이름을 입력해 주세요.').max(30);
const description = z
  .string()
  .trim()
  .max(200)
  .nullable()
  .transform((value) => value || null);

export const CreatePack = z
  .object({
    name: packName,
    description: description.optional(),
    type: z.enum(PACK_TYPE).default('MINE'),
    categoryId: z.uuid().nullable().optional(),
  })
  .meta({ id: 'CreatePack' });
export type CreatePack = z.infer<typeof CreatePack>;

export const UpdatePack = z
  .object({
    name: packName.optional(),
    description: description.optional(),
    categoryId: z.uuid().nullable().optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: '수정할 항목이 없습니다.',
  })
  .meta({ id: 'UpdatePack' });
export type UpdatePack = z.infer<typeof UpdatePack>;

export const PackListQuery = CursorQuery.extend({
  type: z.enum(PACK_TYPE),
  categoryId: z.uuid().optional(),
  q: z.string().trim().min(1).max(30).optional(),
  sort: z.enum(PACK_SORT).default('RECOMMENDED'),
});
export type PackListQuery = z.infer<typeof PackListQuery>;

const packSummaryShape = {
  packId: z.string(),
  type: z.enum(PACK_TYPE),
  name: z.string(),
  description: z.string().nullable(),
  categoryId: z.string().nullable(),
  wordCount: z.number().int(),
  progress: z.object({ studied: z.number().int(), total: z.number().int() }),
  lastStudiedAt: z.iso.datetime().nullable(),
  shared: z.boolean(),
};

export const PackSummary = z.object(packSummaryShape).meta({ id: 'PackSummary' });
export type PackSummary = z.infer<typeof PackSummary>;

export const PackPage = cursorPage(PackSummary).meta({ id: 'PackPage' });

export const PackDetail = z
  .object({
    ...packSummaryShape,
    editable: z.boolean(),
    memoryStatusCount: z.object({
      NEW: z.number().int(),
      LEARNING: z.number().int(),
      MEMORIZED: z.number().int(),
    }),
    share: z
      .object({ shareCode: z.string(), url: z.string() })
      .nullable()
      .describe('공유 중일 때만'),
  })
  .meta({ id: 'PackDetail' });

export const PackCategoryList = z.array(
  z.object({ categoryId: z.string(), name: z.string() }).meta({ id: 'PackCategory' }),
);

export const ShareInfo = z
  .object({ shareCode: z.string(), url: z.string() })
  .meta({ id: 'PackShareInfo' });

export const SharedPackPreview = z
  .object({
    name: z.string(),
    description: z.string().nullable(),
    wordCount: z.number().int(),
    owner: UserSummary,
    previewWords: z.array(WordItem).describe('앞에서부터 최대 20개, memoryStatus는 null'),
    alreadyCopied: z.boolean().describe('복사본을 지웠다면 false'),
    isMine: z.boolean(),
  })
  .meta({ id: 'SharedPackPreview' });
export type SharedPackPreview = z.infer<typeof SharedPackPreview>;
