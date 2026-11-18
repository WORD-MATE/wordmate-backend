import { generateKeyPairSync } from 'node:crypto';

const pem = generateKeyPairSync('ed25519')
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString()
  .trim();

console.log(`JWT_PRIVATE_KEY="${pem.replaceAll('\n', '\\n')}"`);
