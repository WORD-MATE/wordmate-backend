import { describe, expect, it } from 'vitest';
import { classifyApns, classifyFcm, classifyWebPush, isQuietTime } from './push-rules.js';

/** KST 시각으로 Date (KST = UTC+9) */
const kst = (time: string) => new Date(`2026-11-23T${time}:00+09:00`);

describe('isQuietTime', () => {
  it('야간 22:01~07:00에는 보내지 않는다 (22:00 학습 리마인더는 보낸다)', () => {
    expect(isQuietTime('NOTICE', kst('21:59'))).toBe(false);
    expect(isQuietTime('STUDY_REMINDER', kst('22:00'))).toBe(false);
    expect(isQuietTime('NOTICE', kst('22:01'))).toBe(true);
    expect(isQuietTime('NOTICE', kst('03:00'))).toBe(true);
    expect(isQuietTime('NOTICE', kst('06:59'))).toBe(true);
    expect(isQuietTime('NOTICE', kst('07:00'))).toBe(false);
  });

  it('광고성은 21:00~08:00에 보내지 않는다', () => {
    expect(isQuietTime('MARKETING', kst('20:59'))).toBe(false);
    expect(isQuietTime('MARKETING', kst('21:00'))).toBe(true);
    expect(isQuietTime('MARKETING', kst('07:59'))).toBe(true);
    expect(isQuietTime('MARKETING', kst('08:00'))).toBe(false);
  });
});

describe('응답 분류', () => {
  it('APNs', () => {
    expect(classifyApns(200)).toBe('SENT');
    expect(classifyApns(410, 'Unregistered')).toBe('INVALID_TOKEN');
    // 설정 실수로 모든 토큰에 올 수 있어 지우지 않는다
    expect(classifyApns(400, 'BadDeviceToken')).toBe('FAILED');
    expect(classifyApns(400, 'DeviceTokenNotForTopic')).toBe('FAILED');
    expect(classifyApns(400, 'PayloadTooLarge')).toBe('FAILED');
    expect(classifyApns(403, 'ExpiredProviderToken')).toBe('RETRY');
    expect(classifyApns(429)).toBe('RETRY');
    expect(classifyApns(503)).toBe('RETRY');
  });

  it('FCM', () => {
    expect(classifyFcm(200)).toBe('SENT');
    expect(classifyFcm(404, 'UNREGISTERED')).toBe('INVALID_TOKEN');
    expect(classifyFcm(404)).toBe('FAILED');
    expect(classifyFcm(403, 'SENDER_ID_MISMATCH')).toBe('FAILED');
    expect(classifyFcm(400, 'INVALID_ARGUMENT')).toBe('FAILED');
    expect(classifyFcm(401)).toBe('RETRY');
    expect(classifyFcm(500)).toBe('RETRY');
  });

  it('Web Push', () => {
    expect(classifyWebPush(201)).toBe('SENT');
    expect(classifyWebPush(410)).toBe('INVALID_TOKEN');
    expect(classifyWebPush(404)).toBe('INVALID_TOKEN');
    expect(classifyWebPush(413)).toBe('FAILED');
    expect(classifyWebPush(429)).toBe('RETRY');
  });
});
