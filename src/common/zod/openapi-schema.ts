import { type ZodType, z } from 'zod';

type JsonSchema = Record<string, unknown>;

const components = new Map<string, JsonSchema>();

export function toOpenApiSchema(schema: ZodType, io: 'input' | 'output'): JsonSchema {
  const { $schema, $defs, ...json } = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
  }) as JsonSchema & { $defs?: Record<string, JsonSchema> };

  for (const [id, def] of Object.entries($defs ?? {})) {
    components.set(id, rewriteRefs(def));
  }
  return rewriteRefs(json);
}

export function collectedComponents(): Record<string, JsonSchema> {
  return Object.fromEntries(components);
}

function rewriteRefs(json: JsonSchema): JsonSchema {
  return JSON.parse(JSON.stringify(json).replaceAll('"#/$defs/', '"#/components/schemas/'));
}
