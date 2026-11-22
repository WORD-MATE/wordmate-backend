import { HttpStatus } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception.js';

export const AdminUserErrors = {
  userNotFound: () =>
    new AppException('USER_NOT_FOUND', '사용자를 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
  lastAdmin: () =>
    new AppException(
      'ADMIN_LAST_ADMIN',
      '마지막 관리자의 권한은 회수할 수 없습니다.',
      HttpStatus.CONFLICT,
    ),
  notTeacher: () =>
    new AppException('ADMIN_NOT_TEACHER', '교사만 지정할 수 있습니다.', HttpStatus.CONFLICT),
  xpNegative: () =>
    new AppException(
      'ADMIN_XP_NEGATIVE',
      '조정한 뒤 XP가 0보다 작아집니다.',
      HttpStatus.BAD_REQUEST,
    ),
};
