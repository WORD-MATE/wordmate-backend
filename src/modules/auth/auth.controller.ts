import { Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import { AuthErrors } from '../../common/auth/auth-errors.js';
import { AllowDuringMaintenance } from '../../common/client/client.decorators.js';
import { ZodBody, ZodResponse } from '../../common/zod/decorators.js';
import {
  DataGsmLoginRequest,
  LoginResponse,
  RefreshTokenBody,
  TokenResponse,
} from './auth.schemas.js';
import { AuthService } from './auth.service.js';
import { clearAuthCookies, readRefreshToken, setAuthCookies } from './auth-cookies.js';

const isWeb = (request: FastifyRequest) => request.client?.platform === 'WEB';

@ApiTags('auth')
@Auth('ALL')
@AllowDuringMaintenance()
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @ApiOperation({
    summary: 'DataGSM OAuth(PKCE) 로그인',
    description: '웹은 토큰을 쿠키로 발급하고 본문의 토큰은 null',
  })
  @Post('datagsm')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ZodResponse(LoginResponse)
  async login(
    @ZodBody(DataGsmLoginRequest) body: z.infer<typeof DataGsmLoginRequest>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.infer<typeof LoginResponse>> {
    const result = await this.auth.loginWithDataGsm(body, request.client?.platform ?? 'IOS');
    if (!isWeb(request)) return result;

    setAuthCookies(reply, result);
    return { ...result, accessToken: null, refreshToken: null };
  }

  @ApiOperation({
    summary: '토큰 재발급 (리프레시 토큰 회전)',
    description: '앱은 본문 refreshToken, 웹은 __Secure-rt 쿠키',
  })
  @Post('refresh')
  @HttpCode(200)
  @ZodResponse(TokenResponse)
  async refresh(
    @ZodBody(RefreshTokenBody) bodyToken: z.infer<typeof RefreshTokenBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<z.infer<typeof TokenResponse>> {
    const refreshToken = readRefreshToken(request, bodyToken);
    if (!refreshToken) throw AuthErrors.refreshExpired();

    const tokens = await this.auth.refresh(refreshToken);
    if (!isWeb(request)) return tokens;

    setAuthCookies(reply, tokens);
    return { ...tokens, accessToken: null, refreshToken: null };
  }

  @ApiOperation({
    summary: '로그아웃',
    description: '리프레시 토큰만 있으면 됨. 앱은 본문 refreshToken, 웹은 쿠키',
  })
  @Post('logout')
  @HttpCode(204)
  async logout(
    @ZodBody(RefreshTokenBody) bodyToken: z.infer<typeof RefreshTokenBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const refreshToken = readRefreshToken(request, bodyToken);
    if (refreshToken) await this.auth.logout(refreshToken);
    if (isWeb(request)) clearAuthCookies(reply);
  }
}
