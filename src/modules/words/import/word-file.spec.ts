import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { xlsx, zip } from '../../../../test/support/xlsx-fixture.js';
import { AppException } from '../../../common/errors/app-exception.js';
import { readWordFile, WORD_FILE_MAX_ROWS } from './word-file.js';
import { readZipEntries, ZipTooLargeError } from './zip.js';

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppException) return error.code;
    throw error;
  }
  return undefined;
};

const cellsOf = (buffer: Buffer) => readWordFile(buffer).map((row) => [row.line, ...row.cells]);

describe('readWordFile: CSV', () => {
  it('1열 영어, 2열 뜻. 따옴표 안 쉼표, BOM, 빈 행, 머리글을 처리한다', () => {
    const csv = '﻿영어,뜻\r\napple,"사과, 능금"\r\n\r\n,\r\nbanana,바나나,무시되는 열\r\n';
    expect(cellsOf(Buffer.from(csv))).toEqual([
      [2, 'apple', '사과, 능금'],
      [5, 'banana', '바나나'],
    ]);
  });

  it('머리글이 아니면 첫 행도 단어로 본다', () => {
    expect(cellsOf(Buffer.from('cat,고양이\n'))).toEqual([[1, 'cat', '고양이']]);
  });

  it('UTF-8이 아니면 WORD_FILE_ENCODING_INVALID', () => {
    const eucKr = Buffer.from([0x61, 0x2c, 0xbb, 0xe7, 0xb0, 0xfa]);
    expect(codeOf(() => readWordFile(eucKr))).toBe('WORD_FILE_ENCODING_INVALID');
  });

  it('바이너리(xls 등)는 WORD_FILE_TYPE_UNSUPPORTED', () => {
    const xls = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00]);
    expect(codeOf(() => readWordFile(xls))).toBe('WORD_FILE_TYPE_UNSUPPORTED');
  });

  it(`머리글을 빼고 ${WORD_FILE_MAX_ROWS}행까지`, () => {
    const lines = (n: number) => Array.from({ length: n }, (_, i) => `w${i},뜻`);
    expect(
      readWordFile(Buffer.from(['english,뜻', ...lines(WORD_FILE_MAX_ROWS)].join('\n'))),
    ).toHaveLength(WORD_FILE_MAX_ROWS);
    expect(codeOf(() => readWordFile(Buffer.from(lines(WORD_FILE_MAX_ROWS + 1).join('\n'))))).toBe(
      'WORD_FILE_TOO_MANY_ROWS',
    );
  });
});

describe('readWordFile: XLSX', () => {
  it('workbook의 첫 시트를 찾아 A·B열을 읽는다 (공유 문자열·숫자·빈 행)', () => {
    const file = xlsx(
      [
        ['단어', '뜻'],
        ['apple', '사과, 능금'],
        [null, null],
        [2024, '연도'],
        ['run', '달리다', '세 번째 열'],
      ],
      true,
    );
    expect(cellsOf(file)).toEqual([
      [2, 'apple', '사과, 능금'],
      [4, '2024', '연도'],
      [5, 'run', '달리다'],
    ]);
  });

  it('행이 너무 많으면 끝까지 읽지 않고 WORD_FILE_TOO_MANY_ROWS', () => {
    const rows = Array.from({ length: WORD_FILE_MAX_ROWS + 2 }, (_, i) => [`w${i}`, '뜻']);
    expect(codeOf(() => readWordFile(xlsx(rows)))).toBe('WORD_FILE_TOO_MANY_ROWS');
  });

  it('xlsx가 아닌 zip은 WORD_FILE_TYPE_UNSUPPORTED', () => {
    expect(codeOf(() => readWordFile(zip({ 'hello.txt': 'hi' })))).toBe(
      'WORD_FILE_TYPE_UNSUPPORTED',
    );
    const broken = xlsx([['a', 'b']]).subarray(0, 100);
    expect(codeOf(() => readWordFile(broken))).toBe('WORD_FILE_TYPE_UNSUPPORTED');
  });

  it('압축을 푼 크기가 한도를 넘으면 WORD_FILE_TOO_LARGE (압축 폭탄)', () => {
    const bomb = zip({
      'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': Buffer.alloc(64 * 1024 * 1024, 0x20),
    });
    expect(bomb.length).toBeLessThan(200 * 1024);
    expect(codeOf(() => readWordFile(bomb))).toBe('WORD_FILE_TOO_LARGE');
  });
});

describe('readZipEntries', () => {
  it('헤더에 적힌 크기가 아니라 실제로 푼 크기로 한도를 건다', () => {
    const file = zip({ 'a.txt': Buffer.alloc(10_000) });
    expect(() => readZipEntries(file, () => true, 1_000)).toThrow(ZipTooLargeError);
    expect(readZipEntries(file, () => true, 10_000).get('a.txt')).toHaveLength(10_000);
    expect(deflateRawSync(Buffer.alloc(10_000)).length).toBeLessThan(100);
  });
});
