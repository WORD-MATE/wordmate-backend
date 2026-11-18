import { generateKeyPairSync } from 'node:crypto';

export const TEST_REDIRECT_URI = 'wordmate://oauth/callback';

export function applyTestEnv(): void {
  process.env.JWT_PRIVATE_KEY = generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  process.env.DATAGSM_CLIENT_ID = 'test-client';
  process.env.DATAGSM_REDIRECT_URIS = TEST_REDIRECT_URI;
}
