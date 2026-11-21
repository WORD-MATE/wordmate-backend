import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';

export const IDEMPOTENT = Symbol('IDEMPOTENT');

export type IdempotentOptions = { required: boolean };

/** required면 Idempotency-Key 없이 보낸 요청을 400으로 거절한다 */
export const Idempotent = (options: IdempotentOptions = { required: false }) =>
  applyDecorators(
    SetMetadata(IDEMPOTENT, options),
    ApiHeader({
      name: 'Idempotency-Key',
      required: options.required,
      description: '재전송 시 같은 UUID를 보내면 처음 응답을 그대로 돌려줍니다 (24시간 유지).',
      schema: { type: 'string', format: 'uuid' },
    }),
  );
