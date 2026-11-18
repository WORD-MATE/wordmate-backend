import { SetMetadata } from '@nestjs/common';

export const SKIP_CLIENT_CHECK = Symbol('SKIP_CLIENT_CHECK');
export const ALLOW_DURING_MAINTENANCE = Symbol('ALLOW_DURING_MAINTENANCE');

/** 클라이언트 헤더·버전·점검 검사를 모두 건너뛴다. 인프라용 엔드포인트(/health 등)에만 사용. */
export const SkipClientCheck = () => SetMetadata(SKIP_CLIENT_CHECK, true);

export const AllowDuringMaintenance = () => SetMetadata(ALLOW_DURING_MAINTENANCE, true);
