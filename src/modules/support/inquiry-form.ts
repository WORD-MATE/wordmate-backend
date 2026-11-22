import type { FastifyRequest } from 'fastify';
import { CommonErrors } from '../../common/errors/app-exception.js';
import { ZodValidationPipe } from '../../common/zod/zod-validation.pipe.js';
import { CreateInquiry } from './inquiries.schemas.js';
import {
  INQUIRY_IMAGE_MAX_BYTES,
  INQUIRY_IMAGE_MAX_COUNT,
  InquiryImageErrors,
} from './inquiry-image.js';

const IMAGE_FIELD = 'images';
const MAX_FIELDS = 10;

export type InquiryForm = { body: CreateInquiry; images: Buffer[] };

const validate = new ZodValidationPipe(CreateInquiry);

/** 전역 multipart 제한(파일 1개)을 이 요청만 이미지 개수에 맞춰 넓힌다 */
export async function readInquiryForm(request: FastifyRequest): Promise<InquiryForm> {
  if (!request.isMultipart()) {
    throw CommonErrors.invalidRequest(
      { header: 'Content-Type' },
      'multipart/form-data로 보내 주세요.',
    );
  }
  const fields: Record<string, string> = {};
  const images: Buffer[] = [];
  try {
    const parts = request.parts({
      limits: {
        files: INQUIRY_IMAGE_MAX_COUNT,
        fileSize: INQUIRY_IMAGE_MAX_BYTES,
        fields: MAX_FIELDS,
        parts: MAX_FIELDS + INQUIRY_IMAGE_MAX_COUNT,
        fieldSize: 16 * 1024,
      },
    });
    for await (const part of parts) {
      if (part.type === 'field') {
        fields[part.fieldname] = String(part.value);
        continue;
      }
      if (part.fieldname !== IMAGE_FIELD) {
        throw CommonErrors.invalidRequest(
          { field: part.fieldname },
          `파일은 ${IMAGE_FIELD} 필드로 보내 주세요.`,
        );
      }
      images.push(await part.toBuffer());
    }
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'FST_REQ_FILE_TOO_LARGE') throw InquiryImageErrors.tooLarge();
    if (code === 'FST_FILES_LIMIT') {
      throw CommonErrors.invalidRequest(
        { field: IMAGE_FIELD, max: INQUIRY_IMAGE_MAX_COUNT },
        `이미지는 ${INQUIRY_IMAGE_MAX_COUNT}장까지 올릴 수 있습니다.`,
      );
    }
    if (code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT') {
      throw CommonErrors.invalidRequest(null, '필드가 너무 많습니다.');
    }
    throw error;
  }
  return { body: validate.transform(fields) as CreateInquiry, images };
}
