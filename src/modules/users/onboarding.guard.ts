import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AUTH_KEY, type Authority } from '../../common/auth/auth.decorator.js';
import {
  SKIP_TEACHER_CLASS_CHECK,
  SKIP_TERMS_CHECK,
} from '../../common/auth/onboarding.decorator.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AgreementService } from './agreement.service.js';
import { TeacherClassService } from './teacher-class.service.js';

export const OnboardingErrors = {
  termsRequired: () =>
    new AppException(
      'TERMS_AGREEMENT_REQUIRED',
      '필수 약관에 동의해야 합니다.',
      HttpStatus.FORBIDDEN,
    ),
  teacherClassRequired: () =>
    new AppException('TEACHER_CLASS_REQUIRED', '담당 반을 선택해야 합니다.', HttpStatus.FORBIDDEN),
};

/** 약관 동의 → (교사) 담당 반 선택 순서로 온보딩을 마쳤는지 검사한다 */
@Injectable()
export class OnboardingGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly agreements: AgreementService,
    private readonly teacherClasses: TeacherClassService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<FastifyRequest>();
    if (!user) return true;
    const targets = [context.getHandler(), context.getClass()];
    const flag = (key: symbol) => this.reflector.getAllAndOverride<boolean>(key, targets) === true;

    const authorities = this.reflector.getAllAndOverride<Authority[] | undefined>(
      AUTH_KEY,
      targets,
    );
    if (authorities?.includes('ALL') || flag(SKIP_TERMS_CHECK)) return true;

    if (await this.agreements.needsAgreement(user.userId)) throw OnboardingErrors.termsRequired();

    // 관리자 겸 교사는 반을 고르지 않아도 관리 기능을 쓸 수 있어야 한다
    if (user.role !== 'TEACHER' || user.isAdmin || flag(SKIP_TEACHER_CLASS_CHECK)) return true;
    if (!(await this.teacherClasses.has(user.userId))) {
      throw OnboardingErrors.teacherClassRequired();
    }
    return true;
  }
}
