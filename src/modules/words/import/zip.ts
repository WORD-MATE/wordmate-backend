import { inflateRawSync } from 'node:zlib';

export class ZipInvalidError extends Error {}
export class ZipTooLargeError extends Error {}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;

type Entry = { name: string; method: number; compressedSize: number; localOffset: number };

export const isZip = (buffer: Buffer): boolean =>
  buffer.length >= 4 && buffer.readUInt32LE(0) === LOCAL_SIGNATURE;

/**
 * 중앙 디렉터리를 읽어 원하는 항목만 푼다. 압축 폭탄 대비로 푼 크기의 합이 maxTotalBytes를 넘으면
 * 헤더에 적힌 크기와 상관없이 zlib의 maxOutputLength로 바로 멈춘다.
 */
export function readZipEntries(
  buffer: Buffer,
  wanted: (name: string) => boolean,
  maxTotalBytes: number,
): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  let remaining = maxTotalBytes;
  for (const entry of listEntries(buffer)) {
    if (!wanted(entry.name)) continue;
    const data = entryData(buffer, entry);
    let output: Buffer;
    if (entry.method === 0) {
      output = data;
    } else if (entry.method === 8) {
      try {
        output = inflateRawSync(data, { maxOutputLength: Math.max(remaining, 1) });
      } catch (error) {
        if (error instanceof RangeError) throw new ZipTooLargeError();
        throw new ZipInvalidError();
      }
    } else {
      throw new ZipInvalidError();
    }
    if (output.length > remaining) throw new ZipTooLargeError();
    remaining -= output.length;
    result.set(entry.name, output);
  }
  return result;
}

function listEntries(buffer: Buffer): Entry[] {
  const eocd = findEocd(buffer);
  const count = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  // ZIP64는 4GB·65535개를 넘을 때만 쓰이므로 5MB 업로드에서는 지원하지 않는다
  if (count === 0xffff || centralOffset === 0xffffffff) throw new ZipInvalidError();

  const entries: Entry[] = [];
  let offset = centralOffset;
  for (let i = 0; i < count; i++) {
    ensure(buffer, offset, 46);
    if (buffer.readUInt32LE(offset) !== CENTRAL_SIGNATURE) throw new ZipInvalidError();
    const flags = buffer.readUInt16LE(offset + 8);
    if (flags & 0x1) throw new ZipInvalidError();
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    ensure(buffer, offset + 46, nameLength);
    entries.push({
      name: buffer.toString('utf8', offset + 46, offset + 46 + nameLength),
      method: buffer.readUInt16LE(offset + 10),
      compressedSize: buffer.readUInt32LE(offset + 20),
      localOffset: buffer.readUInt32LE(offset + 42),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function findEocd(buffer: Buffer): number {
  const stop = Math.max(0, buffer.length - EOCD_MIN_LENGTH - MAX_COMMENT_LENGTH);
  for (let offset = buffer.length - EOCD_MIN_LENGTH; offset >= stop; offset--) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  throw new ZipInvalidError();
}

function entryData(buffer: Buffer, entry: Entry): Buffer {
  ensure(buffer, entry.localOffset, 30);
  if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIGNATURE) throw new ZipInvalidError();
  const start =
    entry.localOffset +
    30 +
    buffer.readUInt16LE(entry.localOffset + 26) +
    buffer.readUInt16LE(entry.localOffset + 28);
  ensure(buffer, start, entry.compressedSize);
  return buffer.subarray(start, start + entry.compressedSize);
}

function ensure(buffer: Buffer, offset: number, length: number): void {
  if (offset < 0 || offset + length > buffer.length) throw new ZipInvalidError();
}
