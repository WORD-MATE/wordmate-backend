import { randomInt } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException, CommonErrors } from '../../common/errors/app-exception.js';
import { type Database, DB, type Transaction } from '../../infra/db/db.module.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import { type Pack, packCopies, packs, users, words } from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import { ForbiddenWordsService } from '../forbidden-words/forbidden-words.service.js';
import { toUserSummary } from '../users/user-summary.js';
import { toWordItem } from '../words/words.service.js';
import type { PackSummary, SharedPackPreview } from './packs.schemas.js';
import { PackErrors, PacksService, toPackSummary } from './packs.service.js';

export const PREVIEW_WORD_LIMIT = 20;
// 헷갈리는 글자(0·O·1·l·I)를 뺀 56자 × 12자리
const SHARE_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
const SHARE_CODE_LENGTH = 12;
const SHARE_CODE_INDEX = 'share_code_unique';
const PACK_NAME_MAX = 30;
const INSERT_CHUNK = 500;

export const ShareErrors = {
  notFound: () =>
    new AppException(
      'PACK_SHARE_NOT_FOUND',
      '공유가 중지되었거나 삭제된 단어팩입니다.',
      HttpStatus.NOT_FOUND,
    ),
  empty: () =>
    new AppException(
      'PACK_EMPTY',
      '단어가 없는 단어팩은 공유할 수 없습니다.',
      HttpStatus.BAD_REQUEST,
    ),
  alreadyCopied: () =>
    new AppException('PACK_ALREADY_COPIED', '이미 복사한 단어팩입니다.', HttpStatus.CONFLICT),
  ownPack: () =>
    new AppException(
      'PACK_COPY_OWN',
      '내가 공유한 단어팩은 복사할 수 없습니다.',
      HttpStatus.BAD_REQUEST,
    ),
};

const generateShareCode = () =>
  Array.from(
    { length: SHARE_CODE_LENGTH },
    () => SHARE_CODE_ALPHABET[randomInt(SHARE_CODE_ALPHABET.length)],
  ).join('');

/** "이름", "이름 (2)", "이름 (3)" … 중 내 팩과 겹치지 않는 첫 이름 (30자를 넘으면 원래 이름을 자른다) */
export function nextAvailableName(base: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : ` (${n})`;
    const name = base.slice(0, PACK_NAME_MAX - suffix.length).trimEnd() + suffix;
    if (!used.has(name.toLowerCase())) return name;
  }
}

@Injectable()
export class PackShareService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly packs: PacksService,
    private readonly forbiddenWords: ForbiddenWordsService,
  ) {}

  /** 이미 공유 중이면 같은 코드를 돌려준다. 공유를 켜는 시점에 이름·설명·모든 단어를 금칙어로 다시 검사 */
  async share(user: AuthUser, packId: string) {
    const pack = await this.packs.findEditable(user, packId);
    if (pack.type !== 'MINE') throw CommonErrors.forbidden('기본 단어팩은 공유할 수 없습니다.');
    if (pack.shareCode) return this.packs.shareInfo(pack.shareCode);
    if (pack.wordCount === 0) throw ShareErrors.empty();
    await this.assertShareable(pack);

    for (let attempt = 0; ; attempt++) {
      const code = generateShareCode();
      try {
        const [result] = await this.db
          .update(packs)
          .set({ shareCode: code, sharedAt: new Date() })
          .where(and(eq(packs.id, pack.id), isNull(packs.shareCode), isNull(packs.deletedAt)));
        if (result.affectedRows === 1) return this.packs.shareInfo(code);
        // 동시에 다른 요청이 먼저 공유했거나 그사이 삭제됨
        const current = await this.packs.findById(pack.id);
        if (current.shareCode) return this.packs.shareInfo(current.shareCode);
        throw PackErrors.notFound();
      } catch (error) {
        if (attempt < 2 && isDuplicateKeyError(error, SHARE_CODE_INDEX)) continue;
        throw error;
      }
    }
  }

  /** 공유 중이 아니어도 204. 다시 공유하면 새 코드가 생긴다 (예전 링크는 계속 무효) */
  async unshare(user: AuthUser, packId: string): Promise<void> {
    const pack = await this.packs.findEditable(user, packId);
    await this.db
      .update(packs)
      .set({ shareCode: null, sharedAt: null })
      .where(eq(packs.id, pack.id));
  }

  async preview(user: AuthUser, shareCode: string): Promise<SharedPackPreview> {
    const pack = await this.findShared(shareCode);
    const [owner] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, pack.ownerUserId as string));
    if (!owner) throw ShareErrors.notFound();

    const previewWords = await this.db
      .select()
      .from(words)
      .where(and(eq(words.packId, pack.id), isNull(words.deletedAt)))
      .orderBy(asc(words.id))
      .limit(PREVIEW_WORD_LIMIT);
    const isMine = owner.id === user.userId;
    return {
      name: pack.name,
      description: pack.description,
      wordCount: pack.wordCount,
      owner: toUserSummary(owner),
      // 보는 사람의 학습 기록과는 무관한 미리보기
      previewWords: previewWords.map((word) => ({ ...toWordItem(word), memoryStatus: null })),
      alreadyCopied: !isMine && (await this.activeCopyOf(this.db, user.userId, pack.id)) !== null,
      isMine,
    };
  }

  /** 단어까지 통째로 복사한 독립된 내 단어팩을 만든다. 이름이 겹치면 " (2)"를 붙인다 */
  async copy(user: AuthUser, shareCode: string): Promise<PackSummary> {
    const source = await this.findShared(shareCode);
    if (source.ownerUserId === user.userId) throw ShareErrors.ownPack();

    const copiedId = newId();
    try {
      await this.db.transaction(async (tx) => {
        await this.packs.assertMinePackSlot(tx, user.userId);
        if (await this.activeCopyOf(tx, user.userId, source.id)) throw ShareErrors.alreadyCopied();

        const taken = await tx
          .select({ name: packs.name })
          .from(packs)
          .where(
            and(
              eq(packs.ownerUserId, user.userId),
              eq(packs.type, 'MINE'),
              isNull(packs.deletedAt),
            ),
          );
        const sourceWords = await tx
          .select()
          .from(words)
          .where(and(eq(words.packId, source.id), isNull(words.deletedAt)))
          .orderBy(asc(words.id));

        await tx.insert(packs).values({
          id: copiedId,
          type: 'MINE',
          ownerUserId: user.userId,
          name: nextAvailableName(
            source.name,
            taken.map((row) => row.name),
          ),
          description: source.description,
          copiedFromPackId: source.id,
          wordCount: sourceWords.length,
        });
        // newId는 같은 프로세스에서 단조 증가라 원본의 단어 순서가 유지된다
        const copies = sourceWords.map((word) => ({
          id: newId(),
          packId: copiedId,
          english: word.english,
          englishNorm: word.englishNorm,
          meanings: word.meanings,
          example: word.example,
          derivatives: word.derivatives,
        }));
        for (let i = 0; i < copies.length; i += INSERT_CHUNK) {
          await tx.insert(words).values(copies.slice(i, i + INSERT_CHUNK));
        }
        await tx
          .insert(packCopies)
          .values({ userId: user.userId, sourcePackId: source.id, copiedPackId: copiedId })
          .onDuplicateKeyUpdate({
            set: { copiedPackId: copiedId, createdAt: sql`CURRENT_TIMESTAMP(3)` },
          });
      });
    } catch (error) {
      if (isDuplicateKeyError(error, 'packs_active_name_uq')) throw PackErrors.nameDuplicate();
      throw error;
    }
    return toPackSummary(await this.packs.findById(copiedId));
  }

  private async findShared(shareCode: string): Promise<Pack> {
    const [pack] = await this.db
      .select()
      .from(packs)
      .where(and(eq(packs.shareCode, shareCode), isNull(packs.deletedAt)));
    if (pack?.type !== 'MINE') throw ShareErrors.notFound();
    return pack;
  }

  /** 복사본을 지웠다면 복사하지 않은 것으로 본다 */
  private async activeCopyOf(
    executor: Database | Transaction,
    userId: string,
    sourcePackId: string,
  ): Promise<string | null> {
    const [row] = await executor
      .select({ id: packs.id })
      .from(packCopies)
      .innerJoin(packs, eq(packs.id, packCopies.copiedPackId))
      .where(
        and(
          eq(packCopies.userId, userId),
          eq(packCopies.sourcePackId, sourcePackId),
          isNull(packs.deletedAt),
        ),
      );
    return row?.id ?? null;
  }

  private async assertShareable(pack: Pack): Promise<void> {
    await this.forbiddenWords.assertClean({ name: pack.name, description: pack.description });
    const packWords = await this.db
      .select({ id: words.id, english: words.english, meanings: words.meanings })
      .from(words)
      .where(and(eq(words.packId, pack.id), isNull(words.deletedAt)));
    // 매처가 공백을 지우므로 뜻을 이어 붙이지 않고 하나씩 검사한다
    for (const word of packWords) {
      await this.forbiddenWords.assertClean({ english: word.english }, { wordId: word.id });
      for (const meaning of word.meanings) {
        await this.forbiddenWords.assertClean({ meanings: meaning }, { wordId: word.id });
      }
    }
  }
}
