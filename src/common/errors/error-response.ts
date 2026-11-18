import { HttpException, HttpStatus } from '@nestjs/common';
import { AppException, type ErrorDetail } from './app-exception.js';

export interface ErrorBody {
  code: string;
  message: string;
  detail: ErrorDetail;
}

export interface ErrorResponse {
  status: number;
  body: ErrorBody;
}

const BAD_REQUEST = { code: 'INVALID_REQUEST', message: '잘못된 요청입니다.' };
const INTERNAL = { code: 'INTERNAL_ERROR', message: '서버 내부 오류가 발생했습니다.' };

const DEFAULTS: Record<number, { code: string; message: string }> = {
  400: BAD_REQUEST,
  401: { code: 'AUTH_INVALID', message: '인증이 필요합니다.' },
  403: { code: 'FORBIDDEN', message: '권한이 없습니다.' },
  404: { code: 'NOT_FOUND', message: '리소스를 찾을 수 없습니다.' },
  405: { code: 'METHOD_NOT_ALLOWED', message: '허용되지 않은 메서드입니다.' },
  409: { code: 'CONFLICT', message: '현재 상태와 충돌합니다.' },
  413: { code: 'PAYLOAD_TOO_LARGE', message: '요청 본문이 너무 큽니다.' },
  415: { code: 'UNSUPPORTED_MEDIA_TYPE', message: '지원하지 않는 Content-Type입니다.' },
  429: { code: 'RATE_LIMITED', message: '요청이 너무 많습니다.' },
  500: INTERNAL,
  503: { code: 'SERVICE_UNAVAILABLE', message: '서비스를 일시적으로 사용할 수 없습니다.' },
};

const fallback = (status: number) => DEFAULTS[status] ?? (status >= 500 ? INTERNAL : BAD_REQUEST);

export function toErrorResponse(exception: unknown): ErrorResponse {
  if (exception instanceof AppException) {
    return {
      status: exception.getStatus(),
      body: { code: exception.code, message: exception.message, detail: exception.detail },
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    return { status, body: { ...fallback(status), detail: null } };
  }

  const status = clientErrorStatus(exception);
  if (status) {
    return { status, body: { ...fallback(status), detail: null } };
  }

  return {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    body: { ...fallback(HttpStatus.INTERNAL_SERVER_ERROR), detail: null },
  };
}

function clientErrorStatus(exception: unknown): number | null {
  if (typeof exception !== 'object' || exception === null || !('statusCode' in exception)) {
    return null;
  }
  const { statusCode } = exception;
  return typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500
    ? statusCode
    : null;
}
