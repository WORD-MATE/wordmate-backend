import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { VALKEY } from '../../infra/valkey/valkey.module.js';
import { isValidVersion } from '../client/version.js';
import { PLATFORM } from '../enums.js';
import { withTimeout } from '../with-timeout.js';

export const APP_CONFIG_KEY = 'app:config';
const CACHE_TTL_MS = 5000;
const READ_TIMEOUT_MS = 500;

export const AppConfig = z.object({
  maintenance: z
    .object({
      enabled: z.boolean(),
      message: z.string(),
      endsAt: z.iso.datetime().nullable(),
    })
    .default({ enabled: false, message: '', endsAt: null }),
  minVersion: z.partialRecord(z.enum(PLATFORM), z.string().refine(isValidVersion)).default({}),
  latestVersion: z.partialRecord(z.enum(PLATFORM), z.string().refine(isValidVersion)).default({}),
  storeUrl: z.partialRecord(z.enum(['IOS', 'ANDROID']), z.url()).default({}),
});
export type AppConfig = z.infer<typeof AppConfig>;

const DEFAULT_CONFIG = AppConfig.parse({});

@Injectable()
export class AppConfigService {
  private readonly logger = new Logger(AppConfigService.name);
  private cache: { value: AppConfig; expiresAt: number } | null = null;

  constructor(@Inject(VALKEY) private readonly valkey: Redis) {}

  async get(): Promise<AppConfig> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.value;

    let value: AppConfig;
    try {
      const raw = await withTimeout(this.valkey.get(APP_CONFIG_KEY), READ_TIMEOUT_MS);
      value = AppConfig.parse(raw ? JSON.parse(raw) : {});
    } catch (error) {
      this.logger.warn(`앱 설정을 읽지 못해 이전 값을 사용합니다: ${String(error)}`);
      value = this.cache?.value ?? DEFAULT_CONFIG;
    }
    this.cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  }

  async set(config: z.input<typeof AppConfig>): Promise<void> {
    await this.valkey.set(APP_CONFIG_KEY, JSON.stringify(AppConfig.parse(config)));
    this.cache = null;
  }
}
