import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { importPKCS8, SignJWT } from 'jose';
import type { Env } from '../../config/env.js';
import { classifyFcm, type PushMessage, type PushOutcome, pushData } from './push-rules.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const REQUEST_TIMEOUT_MS = 10_000;

/** FCM HTTP v1 (서비스 계정으로 받은 OAuth 토큰). 키가 없으면 configured=false */
@Injectable()
export class FcmSender {
  private readonly logger = new Logger(FcmSender.name);
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: ConfigService<Env, true>) {}

  get configured(): boolean {
    return Boolean(
      this.config.get('FCM_PROJECT_ID', { infer: true }) &&
        this.config.get('FCM_CLIENT_EMAIL', { infer: true }) &&
        this.config.get('FCM_PRIVATE_KEY', { infer: true }),
    );
  }

  async send(deviceToken: string, message: PushMessage): Promise<PushOutcome> {
    const project = this.config.get('FCM_PROJECT_ID', { infer: true });
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${project}/messages:send`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await this.oauthToken()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: { title: message.title, body: message.body },
          data: pushData(message),
          android: { priority: 'high' },
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    let errorStatus: string | undefined;
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { status?: string } } | null;
      errorStatus = body?.error?.status;
      if (res.status === 401) this.accessToken = null;
    }
    const outcome = classifyFcm(res.status, errorStatus);
    if (outcome === 'FAILED') this.logger.warn(`FCM 실패 ${res.status} ${errorStatus ?? ''}`);
    return outcome;
  }

  private async oauthToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt) return this.accessToken.value;
    const key = await importPKCS8(
      this.config.get('FCM_PRIVATE_KEY', { infer: true }) ?? '',
      'RS256',
    );
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(this.config.get('FCM_CLIENT_EMAIL', { infer: true }) ?? '')
      .setAudience(TOKEN_URL)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`FCM 인증 실패 ${res.status}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    // 만료 1분 전에 새로 받는다
    this.accessToken = {
      value: body.access_token,
      expiresAt: Date.now() + (body.expires_in - 60) * 1000,
    };
    return body.access_token;
  }
}
