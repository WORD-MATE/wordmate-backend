import { HttpStatus } from '@nestjs/common';
import { AppException, type ErrorDetail } from '../errors/app-exception.js';

const unauthorized = (code: string, message: string) =>
  new AppException(code, message, HttpStatus.UNAUTHORIZED);

const forbidden = (code: string, message: string, detail: ErrorDetail = null) =>
  new AppException(code, message, HttpStatus.FORBIDDEN, detail);

export const AuthErrors = {
  tokenExpired: () => unauthorized('AUTH_TOKEN_EXPIRED', '로그인이 만료되었습니다.'),
  invalidToken: () => unauthorized('AUTH_INVALID', '유효하지 않은 인증 정보입니다.'),
  refreshExpired: () =>
    unauthorized('AUTH_REFRESH_EXPIRED', '로그인이 만료되었습니다. 다시 로그인해 주세요.'),
  refreshReused: () =>
    unauthorized('AUTH_REFRESH_REUSED', '보안을 위해 로그아웃되었습니다. 다시 로그인해 주세요.'),
  accountSuspended: (reason: string | null, until: Date | null) =>
    forbidden('ACCOUNT_SUSPENDED', '이용이 정지된 계정입니다.', {
      reason,
      until: until?.toISOString() ?? null,
    }),
  accountInactive: (reason: 'GRADUATED_OR_LEFT' | 'DATAGSM_PENDING') =>
    forbidden('ACCOUNT_INACTIVE', '이용할 수 없는 계정입니다.', { reason }),
};
