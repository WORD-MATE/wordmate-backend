import { z } from 'zod';
import { PLATFORM } from '../../common/enums.js';

const deviceName = z.string().trim().min(1).max(100);

const base64urlBytes = (bytes: number) =>
  z
    .string()
    .regex(/^[A-Za-z0-9_-]+=*$/, 'base64url이어야 합니다.')
    .refine((value) => Buffer.from(value, 'base64url').length === bytes, {
      message: `${bytes}바이트여야 합니다.`,
    });

const WebPushSubscription = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(700),
  // 잘못된 키는 암호화할 수 없어 보낼 때마다 실패하므로 등록할 때 막는다 (P-256 공개 키 65바이트, auth 16바이트)
  keys: z.object({
    p256dh: base64urlBytes(65),
    auth: base64urlBytes(16),
  }),
});

export const RegisterDevice = z
  .discriminatedUnion('pushType', [
    z.object({
      deviceName,
      pushType: z.null(),
      pushToken: z.null().optional(),
      webPushSubscription: z.null().optional(),
    }),
    z.object({
      deviceName,
      pushType: z.enum(['APNS', 'FCM']),
      pushToken: z.string().trim().min(1).max(512),
      webPushSubscription: z.null().optional(),
    }),
    z.object({
      deviceName,
      pushType: z.literal('WEBPUSH'),
      pushToken: z.null().optional(),
      webPushSubscription: WebPushSubscription,
    }),
  ])
  .meta({ id: 'RegisterDevice' });

export type RegisterDevice = z.infer<typeof RegisterDevice>;

export const RegisterDeviceResponse = z
  .object({ deviceId: z.string() })
  .meta({ id: 'RegisterDeviceResponse' });

export const DeviceSummary = z
  .object({
    deviceId: z.string(),
    platform: z.enum(PLATFORM),
    deviceName: z.string().nullable(),
    lastActiveAt: z.iso.datetime(),
    current: z.boolean(),
  })
  .meta({ id: 'DeviceSummary' });

export const DeviceList = z.array(DeviceSummary);
