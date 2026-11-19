export const MAX_ENGLISH_LENGTH = 50;
export const MAX_MEANINGS = 5;
export const MAX_MEANING_LENGTH = 100;

export const PARSE_ERROR = [
  'NO_SEPARATOR',
  'EMPTY_ENGLISH',
  'EMPTY_MEANING',
  'TOO_LONG',
  'TOO_MANY_MEANINGS',
] as const;
export type ParseError = (typeof PARSE_ERROR)[number];

export type ParsedLine = { english: string | null; meanings: string[]; error: ParseError | null };

/** 저장·표시용: 전각 문자를 반각으로, 앞뒤 공백 제거, 연속 공백은 한 칸 */
export const normalizeEnglish = (value: string): string =>
  value.normalize('NFKC').trim().replace(/\s+/g, ' ');

/** 같은 단어 판정 키: 대소문자 무시 */
export const englishKey = (english: string): string => normalizeEnglish(english).toLowerCase();

const SEPARATOR = /[/,\t]/;

/** 처음 나오는 `/`, `,`, 탭 앞은 영어, 뒤는 뜻. 뜻은 쉼표로 나누고 빈 값·중복은 버린다 */
export function parseLine(line: string): ParsedLine {
  const at = line.search(SEPARATOR);
  if (at < 0) return { english: null, meanings: [], error: 'NO_SEPARATOR' };

  const english = normalizeEnglish(line.slice(0, at)) || null;
  const meanings = [
    ...new Set(
      line
        .slice(at + 1)
        .split(',')
        .map((meaning) => meaning.normalize('NFKC').trim().replace(/\s+/g, ' '))
        .filter(Boolean),
    ),
  ];

  let error: ParseError | null = null;
  if (!english) error = 'EMPTY_ENGLISH';
  else if (meanings.length === 0) error = 'EMPTY_MEANING';
  else if (
    english.length > MAX_ENGLISH_LENGTH ||
    meanings.some((meaning) => meaning.length > MAX_MEANING_LENGTH)
  )
    error = 'TOO_LONG';
  else if (meanings.length > MAX_MEANINGS) error = 'TOO_MANY_MEANINGS';
  return { english, meanings, error };
}

/** 빈 줄은 건너뛰고, line은 원문 기준 1부터 센다 */
export function parseText(text: string): (ParsedLine & { line: number })[] {
  return text
    .replace(/^﻿/, '')
    .split(/\r\n|\r|\n/)
    .flatMap((raw, index) => (raw.trim() ? [{ line: index + 1, ...parseLine(raw) }] : []));
}
