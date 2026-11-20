import { posix } from 'node:path';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import { readZipEntries, ZipInvalidError } from './zip.js';

export type SheetRow = { line: number; cells: [string, string] };

const MAX_META_BYTES = 1024 * 1024;
const MAX_SHEET_BYTES = 20 * 1024 * 1024;

export class XlsxRowLimitError extends Error {}

const localName = (tag: { name: string }) => tag.name.slice(tag.name.indexOf(':') + 1);

/** 첫 번째 시트의 A·B열을 읽는다. 빈 행은 건너뛰고, 행이 maxRows를 넘으면 바로 멈춘다 */
export function readXlsxRows(buffer: Buffer, maxRows: number): SheetRow[] {
  const meta = readZipEntries(
    buffer,
    (name) => name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels',
    MAX_META_BYTES,
  );
  const workbook = meta.get('xl/workbook.xml');
  const rels = meta.get('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new ZipInvalidError();
  const sheetPath = firstSheetPath(workbook.toString('utf8'), rels.toString('utf8'));

  const files = readZipEntries(
    buffer,
    (name) => name === sheetPath || name === 'xl/sharedStrings.xml',
    MAX_SHEET_BYTES,
  );
  const sheet = files.get(sheetPath);
  if (!sheet) throw new ZipInvalidError();
  const sharedXml = files.get('xl/sharedStrings.xml');
  const shared = sharedXml ? readSharedStrings(sharedXml.toString('utf8')) : [];
  return readSheet(sheet.toString('utf8'), shared, maxRows);
}

function parse(
  xml: string,
  handlers: {
    open?: (tag: SaxesTagPlain) => void;
    close?: (tag: SaxesTagPlain) => void;
    text?: (text: string) => void;
  },
): void {
  const parser = new SaxesParser();
  if (handlers.open) parser.on('opentag', handlers.open);
  if (handlers.close) parser.on('closetag', handlers.close);
  if (handlers.text) {
    parser.on('text', handlers.text);
    parser.on('cdata', handlers.text);
  }
  try {
    parser.write(xml).close();
  } catch (error) {
    if (error instanceof XlsxRowLimitError) throw error;
    throw new ZipInvalidError();
  }
}

function firstSheetPath(workbookXml: string, relsXml: string): string {
  let relationId: string | undefined;
  parse(workbookXml, {
    open: (tag) => {
      if (relationId === undefined && localName(tag) === 'sheet') {
        const key = Object.keys(tag.attributes).find((name) => localName({ name }) === 'id');
        relationId = key ? String(tag.attributes[key]) : undefined;
      }
    },
  });
  let target: string | undefined;
  parse(relsXml, {
    open: (tag) => {
      if (localName(tag) === 'Relationship' && tag.attributes.Id === relationId) {
        target = String(tag.attributes.Target);
      }
    },
  });
  if (!relationId || !target) throw new ZipInvalidError();
  return target.startsWith('/') ? target.slice(1) : posix.normalize(posix.join('xl', target));
}

/** <si>마다 <t> 글자를 이어 붙인다. 후리가나(<rPh>)는 뺀다 */
function readSharedStrings(xml: string): string[] {
  const strings: string[] = [];
  let current: string | null = null;
  let inText = false;
  let inPhonetic = false;
  parse(xml, {
    open: (tag) => {
      const name = localName(tag);
      if (name === 'si') current = '';
      else if (name === 'rPh') inPhonetic = true;
      else if (name === 't') inText = true;
    },
    close: (tag) => {
      const name = localName(tag);
      if (name === 'si') {
        strings.push(current ?? '');
        current = null;
      } else if (name === 'rPh') inPhonetic = false;
      else if (name === 't') inText = false;
    },
    text: (text) => {
      if (current !== null && inText && !inPhonetic) current += text;
    },
  });
  return strings;
}

/** "B12" → 1 (0부터). 열 문자가 없으면 null */
function columnIndex(reference: string): number | null {
  const letters = /^[A-Z]+/i.exec(reference)?.[0];
  if (!letters) return null;
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function readSheet(xml: string, shared: string[], maxRows: number): SheetRow[] {
  const rows: SheetRow[] = [];
  let rowNumber = 0;
  let cells: [string, string] = ['', ''];
  let nextColumn = 0;
  let cell: { column: number; type: string } | null = null;
  let value = '';
  let capture = false;
  let inPhonetic = false;

  parse(xml, {
    open: (tag) => {
      const name = localName(tag);
      if (name === 'row') {
        const r = Number(tag.attributes.r);
        rowNumber = Number.isInteger(r) && r > 0 ? r : rowNumber + 1;
        cells = ['', ''];
        nextColumn = 0;
      } else if (name === 'c') {
        const reference = tag.attributes.r ? String(tag.attributes.r) : '';
        const column = columnIndex(reference) ?? nextColumn;
        nextColumn = column + 1;
        cell = { column, type: String(tag.attributes.t ?? 'n') };
        value = '';
      } else if (cell && (name === 'v' || name === 't')) {
        capture = true;
      } else if (name === 'rPh') {
        inPhonetic = true;
      }
    },
    close: (tag) => {
      const name = localName(tag);
      if (name === 'v' || name === 't') capture = false;
      else if (name === 'rPh') inPhonetic = false;
      else if (name === 'c' && cell) {
        if (cell.column < 2) {
          cells[cell.column] = cell.type === 's' ? (shared[Number(value)] ?? '') : value;
        }
        cell = null;
      } else if (name === 'row') {
        if (cells[0].trim() || cells[1].trim()) {
          rows.push({ line: rowNumber, cells });
          if (rows.length > maxRows) throw new XlsxRowLimitError();
        }
      }
    },
    text: (text) => {
      if (capture && !inPhonetic) value += text;
    },
  });
  return rows;
}
