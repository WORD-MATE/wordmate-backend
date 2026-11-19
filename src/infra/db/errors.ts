/** drizzle이 감싼 mysql2 에러까지 확인해 유니크 키 충돌인지 판단한다 */
export function isDuplicateKeyError(error: unknown, indexName?: string): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const { code, message, cause } = current as {
      code?: string;
      message?: string;
      cause?: unknown;
    };
    if (code === 'ER_DUP_ENTRY') return !indexName || (message ?? '').includes(indexName);
    current = cause;
  }
  return false;
}
