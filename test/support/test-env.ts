export const TEST_REDIRECT_URI = 'wordmate://oauth/callback';

export function applyTestEnv(): void {
  process.env.DATAGSM_CLIENT_ID = 'test-client';
  process.env.DATAGSM_REDIRECT_URIS = TEST_REDIRECT_URI;
}
