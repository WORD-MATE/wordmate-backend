import { HttpStatus } from '@nestjs/common';
import sharp from 'sharp';
import { AppException } from '../../common/errors/app-exception.js';

export const INQUIRY_IMAGE_MAX_COUNT = 3;
export const INQUIRY_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
// 작은 파일로 거대한 픽셀 수를 만들어 메모리를 터뜨리는 이미지를 막는다 (임시값)
const MAX_INPUT_PIXELS = 50_000_000;

export type ImageType = 'jpeg' | 'png' | 'webp' | 'heic';
export type AcceptedImageType = Exclude<ImageType, 'heic'>;

export const IMAGE_MIME: Record<AcceptedImageType, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

export const InquiryImageErrors = {
  invalid: (index: number, message = 'JPEG, PNG, WebP 이미지만 올릴 수 있습니다.') =>
    new AppException('INQUIRY_IMAGE_INVALID', message, HttpStatus.BAD_REQUEST, { index }),
  tooLarge: () =>
    new AppException(
      'INQUIRY_IMAGE_TOO_LARGE',
      '이미지는 한 장에 5MB까지 올릴 수 있습니다.',
      HttpStatus.BAD_REQUEST,
      { maxBytes: INQUIRY_IMAGE_MAX_BYTES },
    ),
};

/** 확장자·Content-Type은 클라이언트가 바꿀 수 있으므로 파일 앞부분의 시그니처로 판단한다 */
export function detectImageType(data: Buffer): ImageType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (data.length >= 12) {
    if (data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') {
      return 'webp';
    }
    if (
      data.toString('latin1', 4, 8) === 'ftyp' &&
      HEIF_BRANDS.has(data.toString('latin1', 8, 12))
    ) {
      return 'heic';
    }
  }
  return null;
}

/**
 * 같은 형식으로 다시 인코딩한다. sharp는 메타데이터를 따로 요청하지 않으면 버리므로
 * EXIF(위치 정보 포함)가 빠진다. 회전 정보도 함께 빠지므로 먼저 픽셀에 적용해 둔다
 */
export async function reencodeImage(data: Buffer, type: AcceptedImageType): Promise<Buffer> {
  const image = sharp(data, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' }).rotate();
  if (type === 'jpeg') return image.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
  if (type === 'png') return image.png().toBuffer();
  return image.webp({ quality: 85 }).toBuffer();
}

/** HEIC는 sharp 기본 빌드에 디코더(HEVC)가 없어 거절한다 */
export async function sanitizeImage(
  data: Buffer,
  index: number,
): Promise<{ data: Buffer; mime: string }> {
  const type = detectImageType(data);
  if (type === 'heic') {
    throw InquiryImageErrors.invalid(index, 'HEIC는 올릴 수 없습니다. JPEG로 바꿔 보내 주세요.');
  }
  if (!type) throw InquiryImageErrors.invalid(index);
  try {
    return { data: await reencodeImage(data, type), mime: IMAGE_MIME[type] };
  } catch {
    throw InquiryImageErrors.invalid(index, '이미지를 읽을 수 없습니다.');
  }
}
