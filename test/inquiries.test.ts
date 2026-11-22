import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessTokenService } from '../src/common/auth/access-token.service.js';
import type { AuthUser } from '../src/common/auth/auth-user.js';
import { type Database, DB } from '../src/infra/db/db.module.js';
import {
  auditLogs,
  inquiries,
  inquiryImages,
  type NewUser,
  notifications,
  users,
} from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';
import { VALKEY } from '../src/infra/valkey/valkey.module.js';
import { INQUIRY_RATE_LIMIT } from '../src/modules/support/inquiries.service.js';
import { InquiryImageStorage, UPLOAD_ROOT } from '../src/modules/support/inquiry-image.storage.js';
import { createTestApp, inject } from './support/create-test-app.js';

type FilePart = { data: Buffer; filename?: string; contentType?: string; field?: string };

const multipart = (fields: Record<string, string>, files: FilePart[] = []) => {
  const boundary = `----wordmate${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`),
      Buffer.from(value, 'utf8'),
      Buffer.from('\r\n'),
    );
  }
  for (const file of files) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field ?? 'images'}"; filename="${file.filename ?? 'photo.jpg'}"\r\nContent-Type: ${file.contentType ?? 'image/jpeg'}\r\n\r\n`,
      ),
      file.data,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};

const image = (format: 'jpeg' | 'png', width = 16, height = 12) =>
  sharp({ create: { width, height, channels: 3, background: '#ff8800' } })
    .toFormat(format)
    .withExif({ IFD0: { Copyright: 'wordmate-secret', Artist: 'gps-holder' } })
    .toBuffer();

const fields = (overrides: Record<string, string> = {}) => ({
  type: 'BUG',
  title: '학습 화면 오류',
  content: '단어 카드를 넘기면 화면이 멈춥니다.',
  ...overrides,
});

describe('1:1 문의', () => {
  let app: NestFastifyApplication;
  let db: Database;
  let valkey: Redis;
  let uploadRoot: string;
  let admin: AuthUser;
  const userIds: string[] = [];

  const makeUser = async (overrides: Partial<NewUser> = {}): Promise<AuthUser> => {
    const userId = newId();
    userIds.push(userId);
    const role = overrides.role ?? 'STUDENT';
    await db.insert(users).values({
      id: userId,
      name: `문의${userId.slice(-4)}`,
      role,
      grade: role === 'STUDENT' ? 2 : null,
      classNo: role === 'STUDENT' ? 3 : null,
      ...overrides,
    });
    return { userId, role, isAdmin: overrides.isAdmin ?? false, deviceId: newId() };
  };

  const authorization = async (user: AuthUser) =>
    `Bearer ${await app.get(AccessTokenService).sign(user)}`;

  const submit = async (
    user: AuthUser,
    form: { payload: Buffer; contentType: string },
    headers: Record<string, string> = {},
  ) =>
    inject(app, {
      method: 'POST',
      url: '/inquiries',
      payload: form.payload,
      headers: {
        authorization: await authorization(user),
        'content-type': form.contentType,
        'idempotency-key': randomUUID(),
        ...headers,
      },
    });

  const call = async (user: AuthUser, method: 'GET' | 'POST', url: string, payload?: object) =>
    inject(app, {
      method,
      url,
      payload,
      headers: { authorization: await authorization(user) },
    });

  const storedFiles = async () => readdir(join(uploadRoot, 'inquiries')).catch(() => []);
  const inquiriesOf = (user: AuthUser) =>
    db.select().from(inquiries).where(eq(inquiries.userId, user.userId));

  // 응답 주소의 경로만 떼어 클라이언트 헤더·로그인 없이 연다
  const fetchImage = (url: string) => {
    const { pathname, search } = new URL(url);
    return app.inject({ method: 'GET', url: `${pathname}${search}` });
  };

  beforeAll(async () => {
    uploadRoot = await mkdtemp(join(tmpdir(), 'wordmate-uploads-'));
    app = await createTestApp({ overrides: [[UPLOAD_ROOT, uploadRoot]] });
    db = app.get(DB);
    valkey = app.get(VALKEY);
    admin = await makeUser({ role: 'TEACHER', isAdmin: true });
  });

  afterAll(async () => {
    await db.delete(inquiries).where(inArray(inquiries.userId, userIds));
    await db.delete(auditLogs).where(inArray(auditLogs.actorId, userIds));
    await db.delete(notifications).where(inArray(notifications.userId, userIds));
    await valkey.del(...userIds.map((id) => `inquiry:rate:${id}`));
    await app.close();
    await rm(uploadRoot, { recursive: true, force: true });
  });

  it('이미지와 함께 등록하면 메타데이터를 지워 저장하고, 앱 버전·플랫폼을 남긴다', async () => {
    const user = await makeUser();
    const [jpeg, png] = await Promise.all([image('jpeg', 20, 10), image('png')]);
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();

    const res = await submit(
      user,
      multipart(fields(), [
        { data: jpeg },
        // 확장자·Content-Type이 틀려도 내용으로 판단한다
        { data: png, filename: 'screen.jpg', contentType: 'image/jpeg' },
      ]),
      { 'x-client-platform': 'ANDROID', 'x-client-version': '2.3.4' },
    );
    expect(res.statusCode).toBe(201);
    const { inquiryId } = res.json();

    const [row] = await inquiriesOf(user);
    expect(row).toMatchObject({
      id: inquiryId,
      type: 'BUG',
      status: 'RECEIVED',
      platform: 'ANDROID',
      appVersion: '2.3.4',
    });
    const images = await db
      .select()
      .from(inquiryImages)
      .where(eq(inquiryImages.inquiryId, inquiryId));
    expect(images.map((i) => [i.sortOrder, i.mime])).toEqual(
      expect.arrayContaining([
        [0, 'image/jpeg'],
        [1, 'image/png'],
      ]),
    );
    expect(await storedFiles()).toEqual(expect.arrayContaining(images.map((i) => i.id)));

    const detail = await call(user, 'GET', `/inquiries/${inquiryId}`);
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body).toMatchObject({
      inquiryId,
      type: 'BUG',
      title: '학습 화면 오류',
      content: '단어 카드를 넘기면 화면이 멈춥니다.',
      status: 'RECEIVED',
      answer: null,
    });
    expect(body.images).toHaveLength(2);
    expect(body.images[0].url).toMatch(/\/inquiries\/images\/[0-9a-f-]+\?exp=\d+&sig=/);

    const first = await fetchImage(body.images[0].url);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toBe('image/jpeg');
    const meta = await sharp(first.rawPayload).metadata();
    expect(meta.exif).toBeUndefined();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 20, 10]);
    expect(first.rawPayload.includes(Buffer.from('wordmate-secret'))).toBe(false);

    const second = await fetchImage(body.images[1].url);
    expect(second.headers['content-type']).toBe('image/png');
    expect((await sharp(second.rawPayload).metadata()).exif).toBeUndefined();

    const list = (await call(user, 'GET', '/inquiries')).json();
    expect(list.items).toEqual([
      expect.objectContaining({ inquiryId, type: 'BUG', status: 'RECEIVED' }),
    ]);
    expect(list.nextCursor).toBeNull();
  });

  it('서명 주소는 만료·변조되면 403이고, 서명이 맞아도 없는 이미지는 404', async () => {
    const user = await makeUser();
    const res = await submit(user, multipart(fields(), [{ data: await image('png') }]));
    const detail = (await call(user, 'GET', `/inquiries/${res.json().inquiryId}`)).json();
    const url = new URL(detail.images[0].url);
    const imageId = detail.images[0].imageId as string;
    const storage = app.get(InquiryImageStorage);

    const open = (path: string) => app.inject({ method: 'GET', url: path });
    const exp = url.searchParams.get('exp') as string;
    const sig = url.searchParams.get('sig') as string;
    const tampered = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);

    const expired = await open(storage.signedPath(imageId, Date.now() - 11 * 60 * 1000));
    expect(expired.statusCode).toBe(403);
    expect(expired.json().code).toBe('INQUIRY_IMAGE_URL_INVALID');
    for (const path of [
      `/inquiries/images/${imageId}?exp=${exp}&sig=${tampered}`,
      `/inquiries/images/${imageId}?exp=${Number(exp) + 3600}&sig=${sig}`,
      `/inquiries/images/${imageId}`,
    ]) {
      const blocked = await open(path);
      expect(blocked.statusCode).toBe(403);
      expect(blocked.json().code).toBe('INQUIRY_IMAGE_URL_INVALID');
    }

    const missing = await open(storage.signedPath(newId()));
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('INQUIRY_IMAGE_NOT_FOUND');
  });

  it('필드·이미지가 잘못되면 400이고 아무것도 남기지 않는다', async () => {
    const user = await makeUser();
    const before = await storedFiles();
    const png = await image('png');
    const codeOf = async (res: Awaited<ReturnType<typeof submit>>) => {
      expect(res.statusCode).toBe(400);
      return res.json().code;
    };

    expect(await codeOf(await submit(user, multipart(fields({ title: '' }))))).toBe(
      'INVALID_REQUEST',
    );
    expect(await codeOf(await submit(user, multipart(fields({ title: '가'.repeat(51) }))))).toBe(
      'INVALID_REQUEST',
    );
    expect(await codeOf(await submit(user, multipart(fields({ content: '짧아요' }))))).toBe(
      'INVALID_REQUEST',
    );
    expect(await codeOf(await submit(user, multipart(fields({ type: 'PRAISE' }))))).toBe(
      'INVALID_REQUEST',
    );
    const json = await inject(app, {
      method: 'POST',
      url: '/inquiries',
      payload: fields(),
      headers: { authorization: await authorization(user), 'idempotency-key': randomUUID() },
    });
    expect(await codeOf(json)).toBe('INVALID_REQUEST');
    expect(
      await codeOf(await submit(user, multipart(fields()), { 'idempotency-key': 'not-a-uuid' })),
    ).toBe('INVALID_REQUEST');

    const four = multipart(
      fields(),
      [png, png, png, png].map((data) => ({ data })),
    );
    expect(await codeOf(await submit(user, four))).toBe('INVALID_REQUEST');
    const wrongField = multipart(fields(), [{ data: png, field: 'file' }]);
    expect(await codeOf(await submit(user, wrongField))).toBe('INVALID_REQUEST');

    const huge = Buffer.concat([png.subarray(0, 8), randomBytes(5 * 1024 * 1024)]);
    expect(await codeOf(await submit(user, multipart(fields(), [{ data: huge }])))).toBe(
      'INQUIRY_IMAGE_TOO_LARGE',
    );

    const fake = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypheic', 'latin1'),
      randomBytes(64),
    ]);
    const broken = Buffer.concat([png.subarray(0, 8), randomBytes(256)]);
    for (const data of [fake, heic, broken]) {
      const res = await submit(
        user,
        multipart(fields(), [{ data: png }, { data, filename: 'x.png', contentType: 'image/png' }]),
      );
      expect(await codeOf(res)).toBe('INQUIRY_IMAGE_INVALID');
      expect(res.json().detail).toMatchObject({ index: 1 });
    }

    expect(await inquiriesOf(user)).toHaveLength(0);
    expect((await storedFiles()).sort()).toEqual([...before].sort());
    expect(await valkey.get(`inquiry:rate:${user.userId}`)).toBeNull();
  });

  it(`한 시간에 ${INQUIRY_RATE_LIMIT}건을 넘기면 429`, async () => {
    const user = await makeUser();
    for (let i = 0; i < INQUIRY_RATE_LIMIT; i++) {
      expect((await submit(user, multipart(fields({ title: `문의 ${i}` })))).statusCode).toBe(201);
    }
    const res = await submit(user, multipart(fields()));
    expect(res.statusCode).toBe(429);
    expect(res.json().code).toBe('INQUIRY_TOO_FREQUENT');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(await inquiriesOf(user)).toHaveLength(INQUIRY_RATE_LIMIT);

    // 다른 사람은 영향을 받지 않는다
    expect((await submit(await makeUser(), multipart(fields()))).statusCode).toBe(201);
  });

  it('같은 Idempotency-Key로 다시 보내면 한 건만 만든다', async () => {
    const user = await makeUser();
    const key = randomUUID();
    const png = await image('png');
    const first = await submit(user, multipart(fields(), [{ data: png }]), {
      'idempotency-key': key,
    });
    const again = await submit(user, multipart(fields(), [{ data: png }]), {
      'idempotency-key': key,
    });
    expect(first.statusCode).toBe(201);
    expect(again.json()).toEqual(first.json());
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(await inquiriesOf(user)).toHaveLength(1);
    expect(
      await submit(user, multipart(fields()), { 'idempotency-key': '' }).then((r) => r.statusCode),
    ).toBe(400);
  });

  it('상세는 본인과 관리자만 볼 수 있다', async () => {
    const [owner, other] = await Promise.all([makeUser(), makeUser()]);
    const { inquiryId } = (await submit(owner, multipart(fields()))).json();

    const denied = await call(other, 'GET', `/inquiries/${inquiryId}`);
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('FORBIDDEN');
    expect((await call(admin, 'GET', `/inquiries/${inquiryId}`)).statusCode).toBe(200);
    expect((await call(other, 'GET', '/inquiries')).json().items).toEqual([]);

    const missing = await call(owner, 'GET', `/inquiries/${newId()}`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('INQUIRY_NOT_FOUND');
  });

  it('관리자 목록은 상태·종류로 거르고, 답변하면 처음 한 번만 알린다', async () => {
    const user = await makeUser();
    const { inquiryId } = (
      await submit(user, multipart(fields({ type: 'ACCOUNT', title: '로그인이 안 돼요' })), {
        'x-client-platform': 'WEB',
        'x-client-version': '1.2.0',
      })
    ).json();

    const listed = async (query: string) =>
      (await call(admin, 'GET', `/admin/inquiries?size=100&${query}`))
        .json()
        .items.find((i: { inquiryId: string }) => i.inquiryId === inquiryId);
    expect(await listed('status=RECEIVED&type=ACCOUNT')).toMatchObject({
      user: { userId: user.userId, name: expect.stringContaining('문의') },
      type: 'ACCOUNT',
      title: '로그인이 안 돼요',
      status: 'RECEIVED',
      platform: 'WEB',
      appVersion: '1.2.0',
    });
    expect(await listed('type=BUG')).toBeUndefined();
    expect((await call(user, 'GET', '/admin/inquiries')).statusCode).toBe(403);

    const answerUrl = `/admin/inquiries/${inquiryId}/answer`;
    expect((await call(user, 'POST', answerUrl, { content: '답변' })).statusCode).toBe(403);
    expect((await call(admin, 'POST', answerUrl, { content: '  ' })).statusCode).toBe(400);
    const notFound = await call(admin, 'POST', `/admin/inquiries/${newId()}/answer`, {
      content: '답변',
    });
    expect(notFound.json().code).toBe('INQUIRY_NOT_FOUND');

    expect(
      (await call(admin, 'POST', answerUrl, { content: '비밀번호를 다시 설정해 주세요.' }))
        .statusCode,
    ).toBe(204);
    expect(await listed('status=ANSWERED')).toMatchObject({ status: 'ANSWERED' });
    expect(await listed('status=RECEIVED')).toBeUndefined();

    expect(
      (await call(admin, 'POST', answerUrl, { content: '앱을 최신으로 올린 뒤 다시 해 주세요.' }))
        .statusCode,
    ).toBe(204);
    const detail = (await call(user, 'GET', `/inquiries/${inquiryId}`)).json();
    expect(detail).toMatchObject({
      status: 'ANSWERED',
      answer: { content: '앱을 최신으로 올린 뒤 다시 해 주세요.', answeredAt: expect.any(String) },
    });

    const sent = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.userId, user.userId), eq(notifications.type, 'INQUIRY_ANSWERED')),
      );
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ route: `/inquiries/${inquiryId}` });

    const logs = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, 'INQUIRY_ANSWER'), eq(auditLogs.targetId, inquiryId)));
    expect(logs.map((log) => log.detail)).toEqual(
      expect.arrayContaining([{ edited: false }, { edited: true }]),
    );
    expect(logs.every((log) => log.actorId === admin.userId)).toBe(true);
  });
});
