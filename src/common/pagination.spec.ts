import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AppException } from './errors/app-exception.js';
import { CursorQuery, decodeCursor, encodeCursor, PageQuery, toCursorPage } from './pagination.js';

describe('CursorQuery', () => {
  it('size 기본값 20, 최대 50', () => {
    expect(CursorQuery.parse({})).toEqual({ size: 20 });
    expect(CursorQuery.parse({ size: '50' }).size).toBe(50);
    expect(CursorQuery.safeParse({ size: '51' }).success).toBe(false);
  });
});

describe('PageQuery', () => {
  it('page는 0부터 시작한다', () => {
    expect(PageQuery.parse({})).toEqual({ page: 0, size: 20 });
    expect(PageQuery.safeParse({ page: '-1' }).success).toBe(false);
  });
});

describe('커서', () => {
  const Cursor = z.object({ createdAt: z.string(), id: z.string() });

  it('인코딩한 값을 그대로 복원한다', () => {
    const value = { createdAt: '2026-11-19T00:00:00.000Z', id: 'abc' };
    expect(decodeCursor(encodeCursor(value), Cursor)).toEqual(value);
  });

  it('변조된 커서는 400 INVALID_REQUEST', () => {
    expect(() => decodeCursor('not-a-cursor', Cursor)).toThrow(AppException);
    expect(() => decodeCursor(encodeCursor({ id: 1 }), Cursor)).toThrow(AppException);
  });
});

describe('toCursorPage', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

  it('size보다 많이 조회되면 잘라내고 마지막 항목으로 다음 커서를 만든다', () => {
    const result = toCursorPage(rows, 2, (last) => ({ id: last.id }));
    expect(result.items).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(decodeCursor(result.nextCursor ?? '', z.object({ id: z.string() }))).toEqual({
      id: 'b',
    });
  });

  it('남은 항목이 없으면 nextCursor는 null', () => {
    expect(toCursorPage(rows, 3, (last) => last.id).nextCursor).toBeNull();
    expect(toCursorPage([], 20, () => null)).toEqual({ items: [], nextCursor: null });
  });
});
