import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { type Database, DB } from '../../infra/db/db.module.js';
import { devices } from '../../infra/db/schema/index.js';
import { ApnsSender } from './apns.sender.js';
import { FcmSender } from './fcm.sender.js';
import { isQuietTime, type PushMessage, type PushOutcome } from './push-rules.js';
import { WebPushSender } from './webpush.sender.js';

export const PUSH_QUEUE = 'push';
export const DELIVER_PUSH = 'deliver';
const CHUNK = 1000;

export type DeliverJob = { deviceId: string; message: PushMessage };
type Recipient = { userId: string } & PushMessage;

/** 저장된 알림을 받는 사람의 기기마다 푸시 작업으로 넣고, 작업이 기기별로 보낸다 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(PUSH_QUEUE) private readonly queue: Queue,
    private readonly apns: ApnsSender,
    private readonly fcm: FcmSender,
    private readonly webPush: WebPushSender,
  ) {}

  /** 야간·광고성 금지 시간이면 보내지 않는다 (알림은 이미 목록에 저장돼 있다) */
  async dispatch(notifications: Recipient[], now = new Date()): Promise<number> {
    const sendable = notifications.filter((n) => !isQuietTime(n.type, now));
    let queued = 0;
    for (let i = 0; i < sendable.length; i += CHUNK) {
      const batch = sendable.slice(i, i + CHUNK);
      const rows = await this.db
        .select({ id: devices.id, userId: devices.userId })
        .from(devices)
        .where(
          and(
            inArray(
              devices.userId,
              batch.map((n) => n.userId),
            ),
            isNull(devices.revokedAt),
            isNotNull(devices.pushType),
          ),
        );
      const devicesOf = new Map<string, string[]>();
      for (const row of rows)
        devicesOf.set(row.userId, [...(devicesOf.get(row.userId) ?? []), row.id]);
      const jobs = batch.flatMap(({ userId, ...message }) =>
        (devicesOf.get(userId) ?? []).map((deviceId) => ({
          name: DELIVER_PUSH,
          data: { deviceId, message } satisfies DeliverJob,
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: true,
            removeOnFail: 100,
          },
        })),
      );
      if (jobs.length > 0) await this.queue.addBulk(jobs);
      queued += jobs.length;
    }
    return queued;
  }

  /**
   * 한 기기로 보낸다. 해지된 토큰이면 그 기기의 푸시 등록을 지우고, 잠깐 뒤 다시 보낼 오류면 던져 작업이 재시도한다.
   * 키가 없는 플랫폼은 보내지 않고 넘어간다
   */
  async deliver(
    { deviceId, message }: DeliverJob,
    now = new Date(),
  ): Promise<PushOutcome | 'SKIPPED'> {
    // 재시도하다 금지 시간에 들어가면 보내지 않는다
    if (isQuietTime(message.type, now)) return 'SKIPPED';
    const [device] = await this.db.select().from(devices).where(eq(devices.id, deviceId));
    if (!device || device.revokedAt || !device.pushType) return 'SKIPPED';

    let outcome: PushOutcome;
    if (device.pushType === 'WEBPUSH') {
      if (!this.webPush.configured || !device.webPushEndpoint) return this.skipped('WEBPUSH');
      outcome = await this.webPush.send(
        {
          endpoint: device.webPushEndpoint,
          p256dh: device.webPushP256dh ?? '',
          auth: device.webPushAuth ?? '',
        },
        message,
      );
    } else {
      const sender = device.pushType === 'APNS' ? this.apns : this.fcm;
      if (!sender.configured || !device.pushToken) return this.skipped(device.pushType);
      outcome = await sender.send(device.pushToken, message);
    }

    if (outcome === 'INVALID_TOKEN') await this.unregister(device);
    if (outcome === 'RETRY') throw new Error(`푸시 재시도 필요 (${device.pushType})`);
    return outcome;
  }

  private skipped(type: string): 'SKIPPED' {
    this.logger.debug(`${type} 푸시 키가 없어 보내지 않음`);
    return 'SKIPPED';
  }

  /** 보낸 사이에 새 토큰으로 바뀌었으면 지우지 않는다 */
  private async unregister(device: typeof devices.$inferSelect): Promise<void> {
    await this.db
      .update(devices)
      .set({
        pushType: null,
        pushToken: null,
        webPushEndpoint: null,
        webPushP256dh: null,
        webPushAuth: null,
      })
      .where(
        and(
          eq(devices.id, device.id),
          device.pushType === 'WEBPUSH'
            ? eq(devices.webPushEndpoint, device.webPushEndpoint ?? '')
            : eq(devices.pushToken, device.pushToken ?? ''),
        ),
      );
  }
}
