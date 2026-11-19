import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { forbiddenWords } from '../../infra/db/schema/index.js';
import { ForbiddenWordMatcher } from './forbidden-word-matcher.js';

const CACHE_TTL_MS = 60_000;

export const ForbiddenWordErrors = {
  found: (field: string, extra: Record<string, unknown> = {}) =>
    new AppException(
      'FORBIDDEN_WORD',
      '사용할 수 없는 단어가 포함되어 있습니다.',
      HttpStatus.BAD_REQUEST,
      { field, ...extra },
    ),
};

@Injectable()
export class ForbiddenWordsService {
  private cache: { matcher: ForbiddenWordMatcher; expiresAt: number } | null = null;

  constructor(@Inject(DB) private readonly db: Database) {}

  /** 값이 있는 필드 중 금칙어가 든 첫 필드에서 400 FORBIDDEN_WORD를 던진다 (어떤 단어인지는 알려주지 않음) */
  async assertClean(
    fields: Record<string, string | null | undefined>,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const matcher = await this.matcher();
    for (const [field, value] of Object.entries(fields)) {
      if (value && matcher.find(value)) throw ForbiddenWordErrors.found(field, extra);
    }
  }

  clearCache(): void {
    this.cache = null;
  }

  private async matcher(): Promise<ForbiddenWordMatcher> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.matcher;
    const rows = await this.db.select().from(forbiddenWords);
    const matcher = new ForbiddenWordMatcher(
      rows.filter((row) => row.type === 'FORBIDDEN').map((row) => row.word),
      rows.filter((row) => row.type === 'ALLOWED').map((row) => row.word),
    );
    this.cache = { matcher, expiresAt: Date.now() + CACHE_TTL_MS };
    return matcher;
  }
}
