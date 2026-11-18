import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';

export const IDEMPOTENT = Symbol('IDEMPOTENT');

export const Idempotent = () =>
  applyDecorators(
    SetMetadata(IDEMPOTENT, true),
    ApiHeader({
      name: 'Idempotency-Key',
      required: false,
      description: '재전송 시 같은 UUID를 보내면 처음 응답을 그대로 돌려줍니다 (24시간 유지).',
      schema: { type: 'string', format: 'uuid' },
    }),
  );
