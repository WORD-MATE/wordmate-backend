import type { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';
import { CommonErrors } from '../errors/app-exception.js';

export class ZodValidationPipe<T extends ZodType> implements PipeTransform<unknown, unknown> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): unknown {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw CommonErrors.invalidRequest({
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    return result.data;
  }
}
