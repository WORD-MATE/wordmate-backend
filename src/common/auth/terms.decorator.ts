import { SetMetadata } from '@nestjs/common';

export const SKIP_TERMS_CHECK = Symbol('SKIP_TERMS_CHECK');

/** 필수 약관에 동의하기 전에도 호출할 수 있게 한다 (동의 화면에 필요한 API) */
export const SkipTermsCheck = () => SetMetadata(SKIP_TERMS_CHECK, true);
