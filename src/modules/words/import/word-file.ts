import { HttpStatus } from '@nestjs/common';
import { CsvError, parse } from 'csv-parse/sync';
import { AppException } from '../../../common/errors/app-exception.js';
import { readXlsxRows, type SheetRow, XlsxRowLimitError } from './xlsx.js';
import { isZip, ZipInvalidError, ZipTooLargeError } from './zip.js';

export const WORD_FILE_MAX_BYTES = 5 * 1024 * 1024;
export const WORD_FILE_MAX_ROWS = 1000;

export const WordFileErrors = {
  typeUnsupported: () =>
    new AppException(
      'WORD_FILE_TYPE_UNSUPPORTED',
      'CSV 또는 XLSX 파일만 가져올 수 있습니다.',
      HttpStatus.BAD_REQUEST,
    ),
  tooLarge: () =>
    new AppException(
      'WORD_FILE_TOO_LARGE',
      '파일이 너무 큽니다. 5MB 이하로 올려 주세요.',
      HttpStatus.BAD_REQUEST,
      { maxBytes: WORD_FILE_MAX_BYTES },
    ),
  encodingInvalid: () =>
    new AppException(
      'WORD_FILE_ENCODING_INVALID',
      'CSV는 UTF-8로 저장해 주세요. (엑셀: 다른 이름으로 저장 → CSV UTF-8)',
      HttpStatus.BAD_REQUEST,
    ),
  tooManyRows: () =>
    new AppException(
      'WORD_FILE_TOO_MANY_ROWS',
      `한 번에 ${WORD_FILE_MAX_ROWS}행까지 가져올 수 있습니다.`,
      HttpStatus.BAD_REQUEST,
      { limit: WORD_FILE_MAX_ROWS },
    ),
};

const HEADER_WORDS = new Set(['english', 'word', 'words', 'eng', '영어', '단어', '영단어']);

/** 1열 영어, 2열 뜻. 빈 행은 건너뛰고, 첫 행이 머리글(영어·단어 등)이면 뺀다. 형식은 확장자가 아니라 내용으로 판단 */
export function readWordFile(buffer: Buffer): SheetRow[] {
  // 머리글 1행을 뺄 수 있으므로 한 행 더 읽는다
  const readLimit = WORD_FILE_MAX_ROWS + 1;
  let rows: SheetRow[];
  try {
    rows = isZip(buffer) ? readXlsxRows(buffer, readLimit) : readCsvRows(buffer, readLimit);
  } catch (error) {
    if (error instanceof XlsxRowLimitError) throw WordFileErrors.tooManyRows();
    if (error instanceof ZipTooLargeError) throw WordFileErrors.tooLarge();
    if (error instanceof ZipInvalidError || error instanceof CsvError) {
      throw WordFileErrors.typeUnsupported();
    }
    throw error;
  }

  const first = rows[0];
  if (first && HEADER_WORDS.has(first.cells[0].trim().toLowerCase())) rows = rows.slice(1);
  if (rows.length > WORD_FILE_MAX_ROWS) throw WordFileErrors.tooManyRows();
  return rows;
}

function readCsvRows(buffer: Buffer, maxRows: number): SheetRow[] {
  // NUL 바이트가 있으면 텍스트가 아니다 (xls 같은 바이너리, UTF-16 저장)
  if (buffer.includes(0)) throw WordFileErrors.typeUnsupported();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw WordFileErrors.encodingInvalid();
  }

  // info: true일 때의 반환 형태를 타입이 표현하지 못한다
  const records = parse(text, {
    bom: true,
    info: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
  }) as unknown as { record: string[]; info: { lines: number } }[];
  const rows: SheetRow[] = [];
  for (const { record, info } of records) {
    const cells: [string, string] = [record[0] ?? '', record[1] ?? ''];
    if (!cells[0].trim() && !cells[1].trim()) continue;
    rows.push({ line: info.lines, cells });
    if (rows.length > maxRows) throw WordFileErrors.tooManyRows();
  }
  return rows;
}
