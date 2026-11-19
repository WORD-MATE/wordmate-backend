import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';

if (existsSync('.env')) process.loadEnvFile('.env');

const API_URL = process.argv[2] ?? 'https://wordmate-dev.https.gsmsv.site';
const CLIENT_ID = process.env.DATAGSM_CLIENT_ID;
const AUTH_URL = process.env.DATAGSM_AUTH_URL ?? 'https://oauth.authorization.datagsm.kr';
const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = 'datagsm:account_read datagsm:student_read';
const CLIENT_HEADERS = { 'x-client-platform': 'IOS', 'x-client-version': '1.0.0' };

if (!CLIENT_ID) {
  console.error('.env에 DATAGSM_CLIENT_ID가 없습니다.');
  process.exit(1);
}

const base64url = (buf) => buf.toString('base64url');
const codeVerifier = base64url(randomBytes(48));
const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());
const state = base64url(randomBytes(16));

const authorizeUrl = new URL('/v1/oauth/authorize', AUTH_URL);
authorizeUrl.search = new URLSearchParams({
  response_type: 'code',
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  scope: SCOPE,
  state,
  code_challenge: codeChallenge,
  code_challenge_method: 'S256',
}).toString();

const api = async (method, path, { body, token } = {}) => {
  const res = await fetch(new URL(path, API_URL), {
    method,
    headers: {
      ...CLIENT_HEADERS,
      ...(body && { 'content-type': 'application/json' }),
      ...(token && { authorization: `Bearer ${token}` }),
    },
    body: body && JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

const waitForCode = () =>
  new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const done = (message) => {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end(message);
        server.close();
      };
      const error = url.searchParams.get('error');
      if (error) {
        done(`DataGSM 오류: ${error}`);
        reject(
          new Error(`DataGSM 오류: ${error} ${url.searchParams.get('error_description') ?? ''}`),
        );
      } else if (url.searchParams.get('state') !== state) {
        done('state가 일치하지 않습니다.');
        reject(new Error('state 불일치'));
      } else {
        done('로그인 완료. 터미널로 돌아가세요.');
        resolve(url.searchParams.get('code'));
      }
    });
    server.listen(PORT, '127.0.0.1');
  });

const openBrowser = (url) => {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {});
};

console.log(`API: ${API_URL}`);
console.log('브라우저에서 DataGSM 로그인을 진행하세요. 열리지 않으면 아래 주소를 직접 여세요.\n');
console.log(`${authorizeUrl}\n`);
openBrowser(authorizeUrl.toString());

const code = await waitForCode();
const login = await api('POST', '/auth/datagsm', {
  body: { code, codeVerifier, redirectUri: REDIRECT_URI },
});
if (login.status !== 200) {
  console.error(`로그인 실패 (${login.status})`, login.body);
  process.exit(1);
}

const { accessToken, refreshToken, nextStep, user } = login.body;
console.log(`로그인 성공. nextStep=${nextStep}`);
console.log('user:', user);

const me = await api('GET', '/users/me', { token: accessToken });
console.log(`GET /users/me → ${me.status}`);

const logout = await api('POST', '/auth/logout', { body: { refreshToken } });
console.log(`POST /auth/logout → ${logout.status} (테스트 세션 정리)`);
