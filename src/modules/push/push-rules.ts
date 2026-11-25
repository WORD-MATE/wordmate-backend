import type { NotificationType } from '../../common/enums.js';
import { kstTime } from '../../common/time/kst.js';

export type PushMessage = {
  notificationId: string;
  type: NotificationType;
  title: string;
  body: string;
  route: string | null;
};

/**
 * SENT: 보냄, INVALID_TOKEN: 만료·해지된 토큰(기기 푸시 등록을 지운다),
 * RETRY: 잠깐 뒤 다시(속도 제한·서버 오류·인증 토큰 만료), FAILED: 다시 보내도 안 되는 오류(기록만)
 */
export type PushOutcome = 'SENT' | 'INVALID_TOKEN' | 'RETRY' | 'FAILED';

/**
 * 야간(22:01~07:00)에는 보내지 않고, 광고성은 21:00~08:00에 보내지 않는다 (KST).
 * 학습 리마인더를 22:00으로 정할 수 있으므로 22:00 그 1분은 보낸다
 */
export function isQuietTime(type: NotificationType, at = new Date()): boolean {
  const time = kstTime(at);
  if (type === 'MARKETING') return time >= '21:00' || time < '08:00';
  return time > '22:00' || time < '07:00';
}

const retryable = (status: number) => status === 429 || status >= 500;

/** 다시 보내면 될 수 있는 네트워크 오류 */
export const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ESOCKETTIMEDOUT',
]);

/**
 * APNs 응답. 410(앱 삭제 등)만 토큰 해지로 본다.
 * BadDeviceToken·DeviceTokenNotForTopic은 개발·운영 서버나 번들 ID 설정이 틀려도 모든 토큰에 오므로
 * 등록을 지우지 않고 기록만 한다 (설정 실수 한 번에 iOS 등록이 전부 지워지지 않게)
 */
export function classifyApns(status: number, reason?: string): PushOutcome {
  if (status === 200) return 'SENT';
  if (status === 410) return 'INVALID_TOKEN';
  if (status === 403 && reason === 'ExpiredProviderToken') return 'RETRY';
  return retryable(status) ? 'RETRY' : 'FAILED';
}

/**
 * FCM HTTP v1 응답. 해지 여부는 `details[].errorCode`의 UNREGISTERED로만 판단한다
 * (404·SENDER_ID_MISMATCH는 프로젝트 설정이 틀려도 모든 토큰에 올 수 있어 지우지 않는다)
 */
export function classifyFcm(status: number, errorCode?: string): PushOutcome {
  if (status === 200) return 'SENT';
  if (errorCode === 'UNREGISTERED') return 'INVALID_TOKEN';
  if (status === 401) return 'RETRY';
  return retryable(status) ? 'RETRY' : 'FAILED';
}

/** Web Push 응답 (404·410이면 구독 해지) */
export function classifyWebPush(status: number): PushOutcome {
  if (status >= 200 && status < 300) return 'SENT';
  if (status === 404 || status === 410) return 'INVALID_TOKEN';
  return retryable(status) ? 'RETRY' : 'FAILED';
}

/** 앱이 눌렀을 때 쓰는 데이터 */
export const pushData = (message: PushMessage) => ({
  notificationId: message.notificationId,
  type: message.type,
  route: message.route ?? '',
});
