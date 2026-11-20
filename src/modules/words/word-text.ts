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

/** words.meanings_text (FULLTEXT 검색용) */
export const meaningsText = (meanings: string[]): string => meanings.join(' ');

const NGRAM_TOKEN_SIZE = 2;

/**
 * FULLTEXT로 후보를 좁히는 BOOLEAN MODE 검색어. 공백으로 나눈 낱말마다 구문 검색(+"…")을 건다.
 * ngram 토큰보다 짧은 낱말은 FULLTEXT로 잡히지 않아 빼고, 남는 낱말이 없으면 null (LIKE만 쓴다)
 */
export function fulltextQuery(query: string): string | null {
  const terms = query
    .split(/\s+/)
    .map((term) => term.replaceAll('"', ''))
    .filter((term) => [...term].length >= NGRAM_TOKEN_SIZE);
  return terms.length > 0 ? terms.map((term) => `+"${term}"`).join(' ') : null;
}

/** LIKE '%…%' 패턴 (와일드카드 문자는 글자 그대로) */
export const containsPattern = (query: string): string => `%${query.replace(/[\\%_]/g, '\\$&')}%`;

const SEPARATOR = /[/,\t]/;

/** 처음 나오는 `/`, `,`, 탭 앞은 영어, 뒤는 뜻 */
export function parseLine(line: string): ParsedLine {
  const at = line.search(SEPARATOR);
  if (at < 0) return { english: null, meanings: [], error: 'NO_SEPARATOR' };
  return parseCells(line.slice(0, at), line.slice(at + 1));
}

/** 영어 칸과 뜻 칸을 검사한다. 뜻은 쉼표로 나누고 빈 값·중복은 버린다 (텍스트 분석·파일 가져오기 공통) */
export function parseCells(englishCell: string, meaningsCell: string): ParsedLine {
  const english = normalizeEnglish(englishCell) || null;
  const meanings = [
    ...new Set(
      meaningsCell
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
