import { SetMetadata } from '@nestjs/common';

export const SKIP_TERMS_CHECK = Symbol('SKIP_TERMS_CHECK');
export const SKIP_TEACHER_CLASS_CHECK = Symbol('SKIP_TEACHER_CLASS_CHECK');

/** 필수 약관 동의·교사 담당 반 선택 전에도 호출할 수 있게 한다 (동의 화면에 필요한 API) */
export const SkipTermsCheck = () => SetMetadata(SKIP_TERMS_CHECK, true);

/** 교사가 담당 반을 고르기 전에도 호출할 수 있게 한다 (반 선택 화면에 필요한 API) */
export const SkipTeacherClassCheck = () => SetMetadata(SKIP_TEACHER_CLASS_CHECK, true);
