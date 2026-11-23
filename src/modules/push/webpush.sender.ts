import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webpush, { WebPushError } from 'web-push';
import type { Env } from '../../config/env.js';
import {
  classifyWebPush,
  NETWORK_ERROR_CODES,
  type PushMessage,
  type PushOutcome,
  pushData,
} from './push-rules.js';

export type WebPushSubscription = { endpoint: string; p256dh: string; auth: string };

/** 하루 안에 전달되지 않으면 버린다 */
const TTL_SECONDS = 24 * 60 * 60;
const REQUEST_TIMEOUT_MS = 10_000;

/** Web Push (VAPID). 키가 없으면 configured=false */
@Injectable()
export class WebPushSender {
  private readonly logger = new Logger(WebPushSender.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  get configured(): boolean {
    return Boolean(
      this.config.get('VAPID_PUBLIC_KEY', { infer: true }) &&
        this.config.get('VAPID_PRIVATE_KEY', { infer: true }) &&
        this.config.get('VAPID_SUBJECT', { infer: true }),
    );
  }

  async send(subscription: WebPushSubscription, message: PushMessage): Promise<PushOutcome> {
    try {
      const res = await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify({ title: message.title, body: message.body, ...pushData(message) }),
        {
          TTL: TTL_SECONDS,
          timeout: REQUEST_TIMEOUT_MS,
          vapidDetails: {
            subject: this.config.get('VAPID_SUBJECT', { infer: true }) ?? '',
            publicKey: this.config.get('VAPID_PUBLIC_KEY', { infer: true }) ?? '',
            privateKey: this.config.get('VAPID_PRIVATE_KEY', { infer: true }) ?? '',
          },
        },
      );
      return classifyWebPush(res.statusCode);
    } catch (error) {
      if (error instanceof WebPushError) {
        const outcome = classifyWebPush(error.statusCode);
        if (outcome === 'FAILED') this.logger.warn(`Web Push 실패 ${error.statusCode}`);
        return outcome;
      }
      // 네트워크 오류만 다시 보낸다
      const code = (error as { code?: string }).code;
      if (code && NETWORK_ERROR_CODES.has(code)) return 'RETRY';
      const text = String((error as Error).message ?? error);
      if (/timeout/i.test(text)) return 'RETRY';
      // 구독 키가 잘못되어 암호화할 수 없으면 그 구독은 쓸 수 없다. 그 밖(VAPID 설정 등)은 기록만
      if (/subscription|p256dh|auth secret/i.test(text)) return 'INVALID_TOKEN';
      this.logger.warn(`Web Push 실패: ${text}`);
      return 'FAILED';
    }
  }
}
