import { Controller, Get, Post, Req, Res, StreamableFile } from '@nestjs/common';
import { ApiBody, ApiConsumes, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { SkipClientCheck } from '../../common/client/client.decorators.js';
import type { ClientInfo } from '../../common/client/client.guard.js';
import { INQUIRY_TYPE } from '../../common/enums.js';
import { AppException } from '../../common/errors/app-exception.js';
import { Idempotent } from '../../common/idempotency/idempotent.decorator.js';
import { CursorQuery } from '../../common/pagination.js';
import { ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import { IMAGE_URL_TTL_SECONDS } from './image-url-signer.js';
import { ImageUrlQuery, InquiryCreated, InquiryDetail, InquiryList } from './inquiries.schemas.js';
import {
  INQUIRY_RATE_LIMIT,
  INQUIRY_RATE_WINDOW_SECONDS,
  InquiriesService,
} from './inquiries.service.js';
import { readInquiryForm } from './inquiry-form.js';
import { INQUIRY_IMAGE_MAX_COUNT } from './inquiry-image.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;
const originOf = (request: FastifyRequest) => `${request.protocol}://${request.host}`;

@ApiTags('support')
@Auth('USER')
@Controller('inquiries')
export class InquiriesController {
  constructor(private readonly inquiries: InquiriesService) {}

  @ApiOperation({
    summary: '1:1 문의 등록',
    description: `multipart/form-data. 이미지는 images 필드로 ${INQUIRY_IMAGE_MAX_COUNT}장까지, 한 장에 5MB까지. JPEG·PNG·WebP만(파일 내용으로 판단, HEIC는 거절) 받고, 다시 인코딩해 EXIF(위치 정보)를 지움. 앱 버전·플랫폼은 공통 헤더에서 저장. 한 사람이 ${INQUIRY_RATE_WINDOW_SECONDS / 60}분에 ${INQUIRY_RATE_LIMIT}건까지. 400 INVALID_REQUEST / INQUIRY_IMAGE_INVALID / INQUIRY_IMAGE_TOO_LARGE, 429 INQUIRY_TOO_FREQUENT(Retry-After)`,
  })
  @Post()
  @Idempotent({ required: true })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['type', 'title', 'content'],
      properties: {
        type: { type: 'string', enum: [...INQUIRY_TYPE] },
        title: { type: 'string', minLength: 1, maxLength: 50 },
        content: { type: 'string', minLength: 10, maxLength: 1000 },
        images: {
          type: 'array',
          maxItems: INQUIRY_IMAGE_MAX_COUNT,
          items: { type: 'string', format: 'binary' },
        },
      },
    },
  })
  @ZodResponse(InquiryCreated, { status: 201 })
  async create(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const user = currentUser(request);
    try {
      await this.inquiries.assertNotTooFrequent(user.userId);
      const form = await readInquiryForm(request);
      return await this.inquiries.create(user, request.client as ClientInfo, form);
    } catch (error) {
      if (error instanceof AppException && error.code === 'INQUIRY_TOO_FREQUENT') {
        reply.header('Retry-After', String(error.detail?.retryAfterSeconds ?? 1));
      }
      throw error;
    }
  }

  @ApiOperation({ summary: '내 문의 목록', description: '최신순' })
  @Get()
  @ZodResponse(InquiryList)
  list(@ZodQuery(CursorQuery) query: z.infer<typeof CursorQuery>, @Req() request: FastifyRequest) {
    return this.inquiries.list(currentUser(request), query);
  }

  @ApiOperation({
    summary: '문의 상세',
    description: `본인 문의만, 관리자는 모든 문의. 이미지 주소는 ${IMAGE_URL_TTL_SECONDS / 60}분 동안 유효하니 만료되면 다시 조회. 403 FORBIDDEN / 404 INQUIRY_NOT_FOUND`,
  })
  @Get(':inquiryId')
  @ZodResponse(InquiryDetail)
  detail(@ZodParam('inquiryId', z.uuid()) inquiryId: string, @Req() request: FastifyRequest) {
    return this.inquiries.detail(currentUser(request), inquiryId, originOf(request));
  }
}

/** <img src>로 바로 열 수 있게 로그인·클라이언트 헤더 없이 서명만 확인한다 */
@ApiTags('support')
@Auth('ALL')
@SkipClientCheck()
@Controller('inquiries/images')
export class InquiryImagesController {
  constructor(private readonly inquiries: InquiriesService) {}

  @ApiOperation({
    summary: '문의 이미지',
    description:
      '문의 상세의 images[].url 그대로 사용. 403 INQUIRY_IMAGE_URL_INVALID(만료·변조) / 404 INQUIRY_IMAGE_NOT_FOUND',
  })
  @ApiProduces('image/jpeg', 'image/png', 'image/webp')
  @Get(':imageId')
  async image(
    @ZodParam('imageId', z.uuid()) imageId: string,
    @ZodQuery(ImageUrlQuery) query: z.infer<typeof ImageUrlQuery>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const image = await this.inquiries.image(imageId, query.exp, query.sig);
    // 주소가 만료된 뒤에는 캐시에서도 꺼내 쓰지 않게 남은 시간만큼만 둔다
    const remaining = Math.max(0, Number(query.exp) - Math.floor(Date.now() / 1000));
    reply.header('Cache-Control', `private, max-age=${remaining}`);
    // 웹(다른 Origin)의 <img>에서도 보이게 helmet 기본값 same-origin을 푼다
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    return new StreamableFile(image.data, { type: image.mime, length: image.data.length });
  }
}
