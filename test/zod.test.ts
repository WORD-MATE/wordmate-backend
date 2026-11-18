import { Controller, Get, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ZodBody, ZodQuery, ZodResponse } from '../src/common/zod/decorators.js';
import { createTestApp } from './support/create-test-app.js';

const CreateSample = z.object({ name: z.string().min(1).max(30), count: z.number().int() });
const ListQuery = z.object({ size: z.coerce.number().int().max(50).default(20) });
const Sample = z.object({ name: z.string(), count: z.number() }).meta({ id: 'ZodTestSample' });

@Controller('test-zod')
class ZodTestController {
  @Post()
  @ZodResponse(Sample, { status: 201 })
  create(@ZodBody(CreateSample) body: z.infer<typeof CreateSample>) {
    return { ...body, secret: 'should-be-stripped' };
  }

  @Get()
  list(@ZodQuery(ListQuery) query: z.infer<typeof ListQuery>) {
    return query;
  }
}

describe('Zod 검증과 Swagger', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp({ controllers: [ZodTestController] });
  });

  afterAll(async () => {
    await app.close();
  });

  it('본문이 스키마에 맞으면 통과하고, 응답 스키마에 없는 필드는 제거한다', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/test-zod',
      payload: { name: '단어팩', count: 3 },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ name: '단어팩', count: 3 });
  });

  it('본문이 틀리면 400과 필드별 오류를 돌려준다', async () => {
    const res = await app.inject({ method: 'POST', url: '/test-zod', payload: { name: '' } });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('INVALID_REQUEST');
    expect(body.detail.issues.map((i: { path: string }) => i.path).sort()).toEqual([
      'count',
      'name',
    ]);
  });

  it('쿼리 문자열을 변환하고 기본값을 채운다', async () => {
    expect((await app.inject({ url: '/test-zod?size=10' })).json()).toEqual({ size: 10 });
    expect((await app.inject({ url: '/test-zod' })).json()).toEqual({ size: 20 });
    expect((await app.inject({ url: '/test-zod?size=99' })).statusCode).toBe(400);
  });

  it('OpenAPI 3.1 문서에 Zod 스키마가 반영된다', async () => {
    const res = await app.inject({ url: '/v3/api-docs' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe('3.1.0');

    const post = doc.paths['/test-zod'].post;
    expect(post.requestBody.content['application/json'].schema.required).toEqual(['name', 'count']);
    expect(post.responses['201'].content['application/json'].schema).toEqual({
      $ref: '#/components/schemas/ZodTestSample',
    });
    expect(doc.components.schemas.ZodTestSample).toBeDefined();

    const sizeParam = doc.paths['/test-zod'].get.parameters.find(
      (p: { name: string }) => p.name === 'size',
    );
    expect(sizeParam).toMatchObject({ in: 'query', required: false });
  });

  it('Swagger UI를 /swagger-ui/index.html에서 연다', async () => {
    const res = await app.inject({ url: '/swagger-ui/index.html' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
  });
});
