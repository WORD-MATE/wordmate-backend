import { HttpStatus } from '@nestjs/common';
import { and, eq, isNull, or } from 'drizzle-orm';
import { AppException, CommonErrors } from '../../common/errors/app-exception.js';
import { packs, type Word, words } from '../../infra/db/schema/index.js';
import { MAX_WORDS_PER_PACK, type WordItem } from './words.schemas.js';

export const WordErrors = {
  notFound: () =>
    new AppException('WORD_NOT_FOUND', '단어를 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
  duplicate: () =>
    new AppException('WORD_DUPLICATE', '같은 단어가 이미 단어팩에 있습니다.', HttpStatus.CONFLICT),
  tooManyLines: () =>
    CommonErrors.invalidRequest(
      { field: 'text', limit: MAX_WORDS_PER_PACK },
      `한 번에 ${MAX_WORDS_PER_PACK}줄까지 분석할 수 있습니다.`,
    ),
};

export function toWordItem(word: Word, favorite = false): WordItem {
  return {
    wordId: word.id,
    english: word.english,
    meanings: word.meanings,
    example: word.example,
    derivatives: word.derivatives,
    // 학습 기록(3단계)이 생기기 전까지 모든 단어는 NEW
    memoryStatus: 'NEW',
    favorite,
  };
}

/** words ⋈ packs 조회에서 이 사용자가 볼 수 있는 단어: 기본 팩 + 내 팩 (삭제된 것 제외) */
export const visibleWords = (userId: string) =>
  and(
    isNull(words.deletedAt),
    isNull(packs.deletedAt),
    or(eq(packs.type, 'DEFAULT'), eq(packs.ownerUserId, userId)),
  );
