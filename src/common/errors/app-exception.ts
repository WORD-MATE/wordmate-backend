import { HttpException, HttpStatus } from '@nestjs/common';

export type ErrorDetail = Record<string, unknown> | null;

export class AppException extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus | number,
    readonly detail: ErrorDetail = null,
  ) {
    super(message, status);
  }
}

export const CommonErrors = {
  invalidRequest: (detail: ErrorDetail = null, message = '잘못된 요청입니다.') =>
    new AppException('INVALID_REQUEST', message, HttpStatus.BAD_REQUEST, detail),
  unauthorized: (message = '로그인이 필요합니다.') =>
    new AppException('AUTH_INVALID', message, HttpStatus.UNAUTHORIZED),
  forbidden: (message = '권한이 없습니다.') =>
    new AppException('FORBIDDEN', message, HttpStatus.FORBIDDEN),
  notFound: (message = '리소스를 찾을 수 없습니다.') =>
    new AppException('NOT_FOUND', message, HttpStatus.NOT_FOUND),
  conflict: (message: string, detail: ErrorDetail = null) =>
    new AppException('CONFLICT', message, HttpStatus.CONFLICT, detail),
};
