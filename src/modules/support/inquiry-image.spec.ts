import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { detectImageType, sanitizeImage } from './inquiry-image.js';

const ftyp = (brand: string) =>
  Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`, 'latin1')]);

const codeOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { code?: string }) => error.code,
  );

describe('detectImageType', () => {
  it('JPEG·PNG·WebP 시그니처를 알아본다', () => {
    expect(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('jpeg');
    expect(
      detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])),
    ).toBe('png');
    expect(detectImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1'))).toBe('webp');
  });

  it('HEIC는 ftyp 브랜드로 알아본다', () => {
    expect(detectImageType(ftyp('heic'))).toBe('heic');
    expect(detectImageType(ftyp('mif1'))).toBe('heic');
    expect(detectImageType(ftyp('isom'))).toBeNull();
  });

  it('확장자만 바꾼 파일이나 짧은 파일은 거른다', () => {
    expect(detectImageType(Buffer.from('GIF89a......', 'latin1'))).toBeNull();
    expect(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(detectImageType(Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'))).toBeNull();
    expect(detectImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe('sanitizeImage', () => {
  it('다시 인코딩하면 EXIF가 빠지고 형식은 그대로다', async () => {
    const jpeg = await sharp({
      create: { width: 8, height: 4, channels: 3, background: '#3366ff' },
    })
      .jpeg()
      .withExif({ IFD0: { Copyright: 'secret' } })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();

    const result = await sanitizeImage(jpeg, 0);
    expect(result.mime).toBe('image/jpeg');
    const meta = await sharp(result.data).metadata();
    expect(meta.exif).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([8, 4]);
  });

  it('시그니처만 맞고 깨진 파일, HEIC, 모르는 형식은 INQUIRY_IMAGE_INVALID', async () => {
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(32, 7)]);
    expect(await codeOf(sanitizeImage(broken, 0))).toBe('INQUIRY_IMAGE_INVALID');
    expect(await codeOf(sanitizeImage(ftyp('heic'), 1))).toBe('INQUIRY_IMAGE_INVALID');
    expect(await codeOf(sanitizeImage(Buffer.from('hello world!'), 2))).toBe(
      'INQUIRY_IMAGE_INVALID',
    );
  });
});
