import { z } from 'zod';
import { DUPLICATE_POLICY, MEMORY_STATUS, PACK_TYPE } from '../../common/enums.js';
import { CursorQuery, cursorPage } from '../../common/pagination.js';
import {
  MAX_ENGLISH_LENGTH,
  MAX_MEANING_LENGTH,
  MAX_MEANINGS,
  normalizeEnglish,
  PARSE_ERROR,
} from './word-text.js';

export const MAX_WORDS_PER_PACK = 1000;
export const MAX_PARSE_TEXT_LENGTH = 100_000;

const unique = (values: string[]) => new Set(values).size === values.length;
const text = (max: number) =>
  z
    .string()
    .transform((value) => value.normalize('NFKC').trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1).max(max));

const english = z
  .string()
  .transform(normalizeEnglish)
  .pipe(z.string().min(1, '영어 단어를 입력해 주세요.').max(MAX_ENGLISH_LENGTH));
const meanings = z
  .array(text(MAX_MEANING_LENGTH))
  .min(1)
  .max(MAX_MEANINGS)
  .refine(unique, '같은 뜻이 두 번 들어 있습니다.');
const example = z
  .string()
  .trim()
  .max(300)
  .nullable()
  .transform((value) => value || null);
const derivatives = z
  .array(text(MAX_ENGLISH_LENGTH))
  .max(10)
  .refine(unique, '중복된 파생어가 있습니다.');

export const WordInput = z
  .object({
    english,
    meanings,
    example: example.optional().describe('기본 단어팩에만 저장'),
    derivatives: derivatives.optional().describe('기본 단어팩에만 저장'),
  })
  .meta({ id: 'WordInput' });
export type WordInput = z.infer<typeof WordInput>;

export const AddWords = z
  .object({
    words: z.array(WordInput).min(1).max(MAX_WORDS_PER_PACK),
    duplicatePolicy: z.enum(DUPLICATE_POLICY).default('SKIP'),
  })
  .meta({ id: 'AddWords' });
export type AddWords = z.infer<typeof AddWords>;

export const UpdateWord = z
  .object({
    english: english.optional(),
    meanings: meanings.optional(),
    example: example.optional(),
    derivatives: derivatives.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: '수정할 항목이 없습니다.',
  })
  .meta({ id: 'UpdateWord' });
export type UpdateWord = z.infer<typeof UpdateWord>;

export const WordListQuery = CursorQuery.extend({ memoryStatus: z.enum(MEMORY_STATUS).optional() });
export type WordListQuery = z.infer<typeof WordListQuery>;

export const WordItem = z
  .object({
    wordId: z.string(),
    english: z.string(),
    meanings: z.array(z.string()).describe('입력 순서, 첫 번째가 대표 뜻'),
    example: z.string().nullable(),
    derivatives: z.array(z.string()),
    memoryStatus: z.enum(MEMORY_STATUS).nullable(),
    favorite: z.boolean(),
  })
  .meta({ id: 'WordItem' });
export type WordItem = z.infer<typeof WordItem>;

export const WordPage = cursorPage(WordItem).meta({ id: 'WordPage' });

export const AddWordsResult = z
  .object({
    added: z.number().int(),
    skipped: z.number().int().describe('이미 있거나 요청 안에서 겹친 단어'),
    overwritten: z.number().int(),
    excluded: z.number().int().describe('팩 단어 한도를 넘어 저장하지 않은 단어'),
    words: z.array(WordItem).describe('추가·덮어쓴 단어'),
  })
  .meta({ id: 'AddWordsResult' });
export type AddWordsResult = z.infer<typeof AddWordsResult>;

export const ParseWords = z
  .object({ text: z.string().max(MAX_PARSE_TEXT_LENGTH) })
  .meta({ id: 'ParseWords' });

export const ParseResult = z
  .object({
    rows: z.array(
      z.object({
        line: z.number().int(),
        english: z.string().nullable(),
        meanings: z.array(z.string()),
        error: z.enum(PARSE_ERROR).nullable(),
        duplicate: z.boolean().describe('같은 팩에 이미 있는 단어'),
      }),
    ),
  })
  .meta({ id: 'ParseResult' });
export type ParseResult = z.infer<typeof ParseResult>;

export const WordSearchQuery = CursorQuery.extend({
  q: z
    .string()
    .transform((value) => value.normalize('NFKC').trim().replace(/\s+/g, ' '))
    .pipe(z.string().min(1, '검색어를 입력해 주세요.').max(MAX_MEANING_LENGTH))
    .describe('영어 또는 뜻, 대소문자 무시·부분 일치'),
});
export type WordSearchQuery = z.infer<typeof WordSearchQuery>;

export const WordWithPack = z
  .object({
    word: WordItem,
    pack: z.object({ packId: z.string(), name: z.string(), type: z.enum(PACK_TYPE) }),
  })
  .meta({ id: 'WordWithPack' });
export type WordWithPack = z.infer<typeof WordWithPack>;

export const WordWithPackPage = cursorPage(WordWithPack).meta({ id: 'WordWithPackPage' });
