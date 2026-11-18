import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppConfigService } from '../app-config/app-config.service.js';
import { PLATFORM, type Platform } from '../enums.js';
import { AppException, CommonErrors } from '../errors/app-exception.js';
import { ALLOW_DURING_MAINTENANCE, SKIP_CLIENT_CHECK } from './client.decorators.js';
import { compareVersions, isValidVersion } from './version.js';

export interface ClientInfo {
  platform: Platform;
  version: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    client?: ClientInfo;
  }
}

const isPlatform = (value: unknown): value is Platform =>
  typeof value === 'string' && (PLATFORM as readonly string[]).includes(value);

@Injectable()
export class ClientGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly appConfig: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_CLIENT_CHECK, targets)) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const platform = request.headers['x-client-platform'];
    const version = request.headers['x-client-version'];

    if (!isPlatform(platform)) {
      throw CommonErrors.invalidRequest(
        { header: 'X-Client-Platform' },
        `X-Client-Platform 헤더는 ${PLATFORM.join(', ')} 중 하나여야 합니다.`,
      );
    }
    if (typeof version !== 'string' || !isValidVersion(version)) {
      throw CommonErrors.invalidRequest(
        { header: 'X-Client-Version' },
        'X-Client-Version 헤더가 올바르지 않습니다.',
      );
    }

    const config = await this.appConfig.get();

    const { maintenance } = config;
    const allowed = this.reflector.getAllAndOverride<boolean>(ALLOW_DURING_MAINTENANCE, targets);
    if (maintenance.enabled && !allowed && !request.user?.isAdmin) {
      throw new AppException(
        'MAINTENANCE',
        maintenance.message || '서버 점검 중입니다.',
        HttpStatus.SERVICE_UNAVAILABLE,
        { message: maintenance.message, endsAt: maintenance.endsAt },
      );
    }

    const minVersion = config.minVersion[platform];
    if (minVersion && compareVersions(version, minVersion) < 0) {
      throw new AppException('UPDATE_REQUIRED', '앱 업데이트가 필요합니다.', 426, {
        storeUrl: platform === 'WEB' ? null : (config.storeUrl[platform] ?? null),
      });
    }

    request.client = { platform, version };
    return true;
  }
}
