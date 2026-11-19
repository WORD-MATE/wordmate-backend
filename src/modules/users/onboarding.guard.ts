import { type CanActivate, type ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AUTH_KEY, type Authority } from '../../common/auth/auth.decorator.js';
import { SKIP_TERMS_CHECK } from '../../common/auth/terms.decorator.js';
import { AppException } from '../../common/errors/app-exception.js';
import { AgreementService } from './agreement.service.js';

@Injectable()
export class TermsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly agreements: AgreementService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const { user } = context.switchToHttp().getRequest<FastifyRequest>();
    if (!user) return true;
    const targets = [context.getHandler(), context.getClass()];
    const authorities = this.reflector.getAllAndOverride<Authority[] | undefined>(
      AUTH_KEY,
      targets,
    );
    if (authorities?.includes('ALL')) return true;
    if (this.reflector.getAllAndOverride<boolean>(SKIP_TERMS_CHECK, targets)) return true;

    if (await this.agreements.needsAgreement(user.userId)) {
      throw new AppException(
        'TERMS_AGREEMENT_REQUIRED',
        '필수 약관에 동의해야 합니다.',
        HttpStatus.FORBIDDEN,
      );
    }
    return true;
  }
}
