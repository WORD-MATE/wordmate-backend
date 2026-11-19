import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  ANONYMOUS_LIMIT_PER_MINUTE,
  defaultLimit,
  USER_LIMIT_PER_MINUTE,
} from './app-throttler.guard.js';

const contextWith = (user: unknown) =>
  ({ switchToHttp: () => ({ getRequest: () => ({ user }) }) }) as unknown as ExecutionContext;

describe('defaultLimit', () => {
  it('로그인 사용자는 사용자별 한도, 비로그인은 더 넉넉한 IP 한도', () => {
    expect(defaultLimit(contextWith({ userId: 'u' }))).toBe(USER_LIMIT_PER_MINUTE);
    expect(defaultLimit(contextWith(undefined))).toBe(ANONYMOUS_LIMIT_PER_MINUTE);
    expect(ANONYMOUS_LIMIT_PER_MINUTE).toBeGreaterThan(USER_LIMIT_PER_MINUTE);
  });
});
