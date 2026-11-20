import { z } from 'zod';
import { PLATFORM } from '../../common/enums.js';

const deviceName = z.string().trim().min(1).max(100);

const WebPushSubscription = z.object({
  endpoint: z.url({ protocol: /^https$/ }).max(700),
  keys: z.object({
    p256dh: z.string().min(1).max(255),
    auth: z.string().min(1).max(64),
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
