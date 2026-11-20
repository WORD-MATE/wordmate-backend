import { Injectable } from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth-user.js';
import type { NextStep } from '../../common/enums.js';
import { AgreementService } from './agreement.service.js';
import { TeacherClassService } from './teacher-class.service.js';

@Injectable()
export class NextStepService {
  constructor(
    private readonly agreements: AgreementService,
    private readonly teacherClasses: TeacherClassService,
  ) {}

  async resolve(user: Pick<AuthUser, 'userId' | 'role' | 'isAdmin'>): Promise<NextStep> {
    if (await this.agreements.needsAgreement(user.userId)) return 'TERMS_AGREEMENT';
    if (user.role === 'TEACHER' && !user.isAdmin && !(await this.teacherClasses.has(user.userId))) {
      return 'TEACHER_CLASS_SELECT';
    }
    return 'HOME';
  }
}
