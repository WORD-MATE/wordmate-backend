import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_REDIRECT_URI = 'wordmate://oauth/callback';

export function applyTestEnv(): void {
  process.env.JWT_PRIVATE_KEY = generateKeyPairSync('ed25519')
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  process.env.DATAGSM_CLIENT_ID = 'test-client';
  process.env.DATAGSM_REDIRECT_URIS = TEST_REDIRECT_URI;
  // 정리 작업이 로컬 개발용 ./uploads 파일을 지우지 않게 테스트마다 빈 폴더를 쓴다
  process.env.UPLOAD_DIR = mkdtempSync(join(tmpdir(), 'wordmate-test-uploads-'));
}
