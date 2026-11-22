import { type ClientHttp2Session, connect } from 'node:http2';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { importPKCS8, SignJWT } from 'jose';
import type { Env } from '../../config/env.js';
import { classifyApns, type PushMessage, type PushOutcome, pushData } from './push-rules.js';

/** Apple이 1시간까지 쓰게 하고 20분 이내 재발급은 막으므로 50분마다 새로 만든다 */
const TOKEN_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;

/** APNs (HTTP/2, 토큰 인증). 키가 없으면 configured=false */
@Injectable()
export class ApnsSender implements OnModuleDestroy {
  private readonly logger = new Logger(ApnsSender.name);
  private session: ClientHttp2Session | null = null;
  private token: { value: string; at: number } | null = null;

  constructor(private readonly config: ConfigService<Env, true>) {}

  get configured(): boolean {
    return Boolean(
      this.config.get('APNS_KEY_P8', { infer: true }) &&
        this.config.get('APNS_KEY_ID', { infer: true }) &&
        this.config.get('APNS_TEAM_ID', { infer: true }) &&
        this.config.get('APNS_BUNDLE_ID', { infer: true }),
    );
  }

  async send(deviceToken: string, message: PushMessage): Promise<PushOutcome> {
    const authorization = `bearer ${await this.providerToken()}`;
    const body = JSON.stringify({
      aps: { alert: { title: message.title, body: message.body }, sound: 'default' },
      ...pushData(message),
    });
    const { status, reason } = await this.request(deviceToken, authorization, body);
    if (status === 403 && reason === 'ExpiredProviderToken') this.token = null;
    const outcome = classifyApns(status, reason);
    if (outcome === 'FAILED') this.logger.warn(`APNs 실패 ${status} ${reason ?? ''}`);
    return outcome;
  }

  onModuleDestroy(): void {
    this.session?.close();
  }

  private async providerToken(): Promise<string> {
    if (this.token && Date.now() - this.token.at < TOKEN_TTL_MS) return this.token.value;
    const key = await importPKCS8(this.config.get('APNS_KEY_P8', { infer: true }) ?? '', 'ES256');
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.config.get('APNS_KEY_ID', { infer: true }) })
      .setIssuer(this.config.get('APNS_TEAM_ID', { infer: true }) ?? '')
      .setIssuedAt()
      .sign(key);
    this.token = { value, at: Date.now() };
    return value;
  }

  private connection(): ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) return this.session;
    const host = this.config.get('APNS_SANDBOX', { infer: true })
      ? 'https://api.sandbox.push.apple.com'
      : 'https://api.push.apple.com';
    const session = connect(host);
    session.on('error', () => session.destroy());
    session.on('goaway', () => session.close());
    this.session = session;
    return session;
  }

  private request(
    deviceToken: string,
    authorization: string,
    body: string,
  ): Promise<{ status: number; reason?: string }> {
    return new Promise((resolve, reject) => {
      const stream = this.connection().request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization,
        'apns-topic': this.config.get('APNS_BUNDLE_ID', { infer: true }) ?? '',
        'apns-push-type': 'alert',
        'content-type': 'application/json',
      });
      stream.setTimeout(REQUEST_TIMEOUT_MS, () => stream.close());
      let status = 0;
      let data = '';
      stream.on('response', (headers) => {
        status = Number(headers[':status'] ?? 0);
      });
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        data += chunk;
      });
      stream.on('end', () => {
        let reason: string | undefined;
        try {
          reason = data ? (JSON.parse(data) as { reason?: string }).reason : undefined;
        } catch {
          reason = undefined;
        }
        // 연결이 끊겨 응답 없이 끝났으면 다시 보낸다
        resolve({ status: status || 503, reason });
      });
      stream.on('error', reject);
      stream.end(body);
    });
  }
}
