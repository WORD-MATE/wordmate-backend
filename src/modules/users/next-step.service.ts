import { Injectable } from '@nestjs/common';
import type { NextStep } from '../../common/enums.js';
import { AgreementService } from './agreement.service.js';

@Injectable()
export class NextStepService {
  constructor(private readonly agreements: AgreementService) {}

  // 교사 담당 반 기능이 들어오면 TEACHER_CLASS_SELECT도 판정한다
  async resolve(userId: string): Promise<NextStep> {
    if (await this.agreements.needsAgreement(userId)) return 'TERMS_AGREEMENT';
    return 'HOME';
  }
}
