import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { collectedComponents, toOpenApiSchema } from './openapi-schema.js';

describe('toOpenApiSchema', () => {
  it('id가 붙은 스키마는 components 참조로 바꾸고 따로 모은다', () => {
    const Sample = z.object({ id: z.string() }).meta({ id: 'SampleForSpec' });
    const json = toOpenApiSchema(z.object({ one: Sample, many: z.array(Sample) }), 'output');

    expect(json).not.toHaveProperty('$schema');
    expect(json).not.toHaveProperty('$defs');
    expect(json.properties).toEqual({
      one: { $ref: '#/components/schemas/SampleForSpec' },
      many: { type: 'array', items: { $ref: '#/components/schemas/SampleForSpec' } },
    });
    expect(collectedComponents().SampleForSpec).toMatchObject({
      type: 'object',
      properties: { id: { type: 'string' } },
    });
  });

  it('입력 스키마에서는 기본값이 있는 필드를 필수로 보지 않는다', () => {
    const json = toOpenApiSchema(
      z.object({ size: z.number().default(20), q: z.string() }),
      'input',
    );
    expect(json.required).toEqual(['q']);
  });
});
