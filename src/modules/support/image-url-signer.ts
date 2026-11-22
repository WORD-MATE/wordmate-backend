import { createHmac, timingSafeEqual } from 'node:crypto';

export const IMAGE_URL_TTL_SECONDS = 10 * 60;

const EXP_PATTERN = /^\d{1,12}$/;

/** 따로 정하지 않으면 JWT 개인키에서 용도별 키를 유도해 같은 키를 두 용도로 쓰지 않는다 */
export function deriveSigningSecret(explicit: string | undefined, jwtPrivateKey: string): Buffer {
  if (explicit) return Buffer.from(explicit, 'utf8');
  return createHmac('sha256', jwtPrivateKey).update('wordmate:inquiry-image-url').digest();
}

export function signImage(secret: Buffer, imageId: string, exp: number): string {
  return createHmac('sha256', secret).update(`${imageId}.${exp}`).digest('base64url');
}

export function imageUrlQuery(
  secret: Buffer,
  imageId: string,
  nowMs: number,
): { exp: number; sig: string } {
  const exp = Math.floor(nowMs / 1000) + IMAGE_URL_TTL_SECONDS;
  return { exp, sig: signImage(secret, imageId, exp) };
}

export function isValidImageSignature(
  secret: Buffer,
  imageId: string,
  exp: unknown,
  sig: unknown,
  nowMs: number,
): boolean {
  if (typeof exp !== 'string' || typeof sig !== 'string' || !EXP_PATTERN.test(exp)) return false;
  if (Number(exp) * 1000 <= nowMs) return false;
  const expected = Buffer.from(signImage(secret, imageId, Number(exp)));
  const given = Buffer.from(sig);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
