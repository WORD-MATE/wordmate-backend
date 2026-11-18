import { applyDecorators, Body, Param, Query, SetMetadata } from '@nestjs/common';
import { ApiBody, ApiParam, ApiQuery, ApiResponse } from '@nestjs/swagger';
import type { ZodObject, ZodType } from 'zod';
import { toOpenApiSchema } from './openapi-schema.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

export const ZOD_RESPONSE = Symbol('ZOD_RESPONSE');

type JsonSchema = Record<string, unknown>;

function applyToMethod(
  target: object,
  key: string | symbol | undefined,
  decorator: MethodDecorator,
) {
  if (key === undefined)
    throw new Error('Zod 파라미터 데코레이터는 메서드 파라미터에만 쓸 수 있습니다.');
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (!descriptor) throw new Error(`메서드를 찾을 수 없습니다: ${String(key)}`);
  decorator(target, key, descriptor);
}

export function ZodBody(schema: ZodType): ParameterDecorator {
  return (target, key, index) => {
    Body(new ZodValidationPipe(schema))(target, key, index);
    applyToMethod(target, key, ApiBody({ schema: toOpenApiSchema(schema, 'input') }));
  };
}

export function ZodQuery(schema: ZodObject): ParameterDecorator {
  return (target, key, index) => {
    Query(new ZodValidationPipe(schema))(target, key, index);
    const json = toOpenApiSchema(schema, 'input');
    const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
    const required = new Set((json.required ?? []) as string[]);
    for (const [name, property] of Object.entries(properties)) {
      applyToMethod(
        target,
        key,
        ApiQuery({ name, required: required.has(name), schema: property }),
      );
    }
  };
}

export function ZodParam(name: string, schema: ZodType): ParameterDecorator {
  return (target, key, index) => {
    Param(name, new ZodValidationPipe(schema))(target, key, index);
    applyToMethod(target, key, ApiParam({ name, schema: toOpenApiSchema(schema, 'input') }));
  };
}

export function ZodResponse(
  schema: ZodType,
  options: { status?: number; description?: string } = {},
): MethodDecorator {
  return applyDecorators(
    SetMetadata(ZOD_RESPONSE, schema),
    ApiResponse({
      status: options.status ?? 200,
      description: options.description ?? '',
      schema: toOpenApiSchema(schema, 'output'),
    }),
  );
}
