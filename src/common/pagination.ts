import { type ZodType, z } from 'zod';
import { CommonErrors } from './errors/app-exception.js';

export const CursorQuery = z.object({
  cursor: z.string().min(1).optional(),
  size: z.coerce.number().int().min(1).max(50).default(20),
});
export type CursorQuery = z.infer<typeof CursorQuery>;

export const cursorPage = <T extends ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export type CursorPage<T> = { items: T[]; nextCursor: string | null };

export const PageQuery = z.object({
  page: z.coerce.number().int().min(0).default(0),
  size: z.coerce.number().int().min(1).max(100).default(20),
});
export type PageQuery = z.infer<typeof PageQuery>;

export const page = <T extends ZodType>(item: T) =>
  z.object({ items: z.array(item), totalCount: z.number().int().min(0) });
export type Page<T> = { items: T[]; totalCount: number };

export function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

export function decodeCursor<T extends ZodType>(cursor: string, schema: T): z.infer<T> {
  try {
    return schema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
  } catch {
    throw CommonErrors.invalidRequest({ field: 'cursor' }, '유효하지 않은 커서입니다.');
  }
}

/** rows는 size + 1개까지 조회한 결과를 넘긴다. 남는 1개로 다음 페이지 존재 여부를 판단한다. */
export function toCursorPage<T>(
  rows: T[],
  size: number,
  cursorOf: (last: T) => unknown,
): CursorPage<T> {
  const items = rows.slice(0, size);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > size && last !== undefined ? encodeCursor(cursorOf(last)) : null,
  };
}
