import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth } from '@nestjs/swagger';

export const AUTHORITY = ['ALL', 'USER', 'STUDENT', 'TEACHER', 'ADMIN'] as const;
export type Authority = (typeof AUTHORITY)[number];

export const AUTH_KEY = Symbol('AUTH');

/** 지정하지 않은 엔드포인트는 USER(로그인 필요)로 취급한다. */
export function Auth(...authorities: [Authority, ...Authority[]]) {
  if (authorities.includes('ALL')) {
    return SetMetadata(AUTH_KEY, authorities);
  }
  return applyDecorators(
    SetMetadata(AUTH_KEY, authorities),
    ApiBearerAuth(),
    ApiCookieAuth('__Host-at'),
  );
}
