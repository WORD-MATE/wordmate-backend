import { describe, expect, it } from 'vitest';
import {
  deriveSigningSecret,
  IMAGE_URL_TTL_SECONDS,
  imageUrlQuery,
  isValidImageSignature,
  signImage,
} from './image-url-signer.js';

const secret = deriveSigningSecret(undefined, 'test-private-key');
const imageId = '019a0000-0000-7000-8000-000000000001';
const now = Date.UTC(2026, 10, 22, 12, 0, 0);

describe('이미지 주소 서명', () => {
  it('10분 동안만 유효하다', () => {
    const { exp, sig } = imageUrlQuery(secret, imageId, now);
    expect(exp).toBe(now / 1000 + IMAGE_URL_TTL_SECONDS);
    expect(isValidImageSignature(secret, imageId, String(exp), sig, now)).toBe(true);
    expect(isValidImageSignature(secret, imageId, String(exp), sig, exp * 1000 - 1)).toBe(true);
    expect(isValidImageSignature(secret, imageId, String(exp), sig, exp * 1000)).toBe(false);
  });

  it('만료 시각·이미지·서명을 바꾸면 거절한다', () => {
    const { exp, sig } = imageUrlQuery(secret, imageId, now);
    const otherId = '019a0000-0000-7000-8000-000000000002';
    expect(isValidImageSignature(secret, imageId, String(exp + 3600), sig, now)).toBe(false);
    expect(isValidImageSignature(secret, otherId, String(exp), sig, now)).toBe(false);
    const tampered = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(isValidImageSignature(secret, imageId, String(exp), tampered, now)).toBe(false);
    expect(isValidImageSignature(secret, imageId, String(exp), 'short', now)).toBe(false);
  });

  it('값이 없거나 형식이 틀리면 거절한다', () => {
    const { exp, sig } = imageUrlQuery(secret, imageId, now);
    expect(isValidImageSignature(secret, imageId, undefined, sig, now)).toBe(false);
    expect(isValidImageSignature(secret, imageId, String(exp), undefined, now)).toBe(false);
    expect(isValidImageSignature(secret, imageId, `${exp}.5`, sig, now)).toBe(false);
    expect(isValidImageSignature(secret, imageId, ['1', '2'], sig, now)).toBe(false);
  });

  it('다른 키로 서명한 주소는 거절한다', () => {
    const { exp, sig } = imageUrlQuery(secret, imageId, now);
    const other = deriveSigningSecret('x'.repeat(32), 'test-private-key');
    expect(isValidImageSignature(other, imageId, String(exp), sig, now)).toBe(false);
    expect(deriveSigningSecret(undefined, 'another-key').equals(secret)).toBe(false);
  });
});

describe('signImage', () => {
  it('같은 입력이면 같은 서명이고, 이미지·만료·비밀값 중 하나만 달라도 바뀐다', () => {
    const exp = 1_800_000_000;
    const sig = signImage(secret, imageId, exp);
    expect(signImage(secret, imageId, exp)).toBe(sig);
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(signImage(secret, imageId, exp + 1)).not.toBe(sig);
    expect(signImage(secret, `${imageId.slice(0, -1)}2`, exp)).not.toBe(sig);
    expect(signImage(deriveSigningSecret(undefined, 'other-key'), imageId, exp)).not.toBe(sig);
  });
});
