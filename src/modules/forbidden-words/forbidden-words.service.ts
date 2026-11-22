import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppException } from '../../common/errors/app-exception.js';
import { withTimeout } from '../../common/with-timeout.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { forbiddenWords } from '../../infra/db/schema/index.js';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { ForbiddenWordMatcher } from './forbidden-word-matcher.js';

/** Valkey를 읽지 못할 때 쓰는 만료 시간 */
const CACHE_TTL_MS = 60_000;
const VERSION_KEY = 'forbidden-words:version';
const READ_TIMEOUT_MS = 300;

export const ForbiddenWordErrors = {
  found: (field: string, extra: Record<string, unknown> = {}) =>
    new AppException(
      'FORBIDDEN_WORD',
      '사용할 수 없는 단어가 포함되어 있습니다.',
      HttpStatus.BAD_REQUEST,
      { field, ...extra },
    ),
};

type Cache = { matcher: ForbiddenWordMatcher; version: string | null; expiresAt: number };

@Injectable()
export class ForbiddenWordsService {
  private readonly logger = new Logger(ForbiddenWordsService.name);
  private cache: Cache | null = null;

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(VALKEY) private readonly valkey: Redis,
  ) {}

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

  /** 금칙어를 바꾼 뒤 부른다. 버전을 올려 다른 서버도 다음 검사 때 새로 읽게 한다 */
  async markChanged(): Promise<void> {
    this.cache = null;
    await this.valkey
      .incr(VERSION_KEY)
      .catch((error: unknown) => this.logger.warn(`금칙어 버전 갱신 실패: ${String(error)}`));
  }

  clearCache(): void {
    this.cache = null;
  }

  private async matcher(): Promise<ForbiddenWordMatcher> {
    const version = await this.version();
    const cache = this.cache;
    if (cache && cache.expiresAt > Date.now() && (version === null || version === cache.version)) {
      return cache.matcher;
    }
    const rows = await this.db.select().from(forbiddenWords);
    const matcher = new ForbiddenWordMatcher(
      rows.filter((row) => row.type === 'FORBIDDEN').map((row) => row.word),
      rows.filter((row) => row.type === 'ALLOWED').map((row) => row.word),
    );
    this.cache = { matcher, version, expiresAt: Date.now() + CACHE_TTL_MS };
    return matcher;
  }

  /** 읽지 못하면 null (만료 시간으로만 갱신) */
  private async version(): Promise<string | null> {
    try {
      return (await withTimeout(this.valkey.get(VERSION_KEY), READ_TIMEOUT_MS)) ?? '0';
    } catch {
      return null;
    }
  }
}
