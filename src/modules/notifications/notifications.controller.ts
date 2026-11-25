import { Controller, Get, HttpCode, Patch, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { SkipTeacherClassCheck, SkipTermsCheck } from '../../common/auth/onboarding.decorator.js';
import { ZodBody, ZodParam, ZodQuery, ZodResponse } from '../../common/zod/decorators.js';
import {
  NotificationListQuery,
  NotificationPage,
  NotificationSettings,
  UnreadCount,
  UpdateNotificationSettings,
} from './notifications.schemas.js';
import { NotificationsService } from './notifications.service.js';

// 약관 재동의·담당 반 선택 전에도 알림(끌 수 없는 제재·새 기기 로그인, 약관 변경 공지 등)은 볼 수 있어야 한다
@ApiTags('notifications')
@SkipTermsCheck()
@SkipTeacherClassCheck()
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @ApiOperation({ summary: '알림 목록', description: '최신순 커서, 30일 보관' })
  @Get()
  @ZodResponse(NotificationPage)
  list(
    @ZodQuery(NotificationListQuery) query: z.infer<typeof NotificationListQuery>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.notifications.list(user, query);
  }

  @ApiOperation({ summary: '안 읽은 알림 수' })
  @Get('unread-count')
  @ZodResponse(UnreadCount)
  unreadCount(@CurrentUser() user: AuthUser) {
    return this.notifications.unreadCount(user);
  }

  @ApiOperation({ summary: '알림 설정', description: '계정 단위라 모든 기기에 같이 적용' })
  @Get('settings')
  @ZodResponse(NotificationSettings)
  settings(@CurrentUser() user: AuthUser) {
    return this.notifications.settings(user);
  }

  @ApiOperation({
    summary: '알림 설정 변경',
    description:
      '학습 리마인더는 07:00~22:00(400 NOTI_REMINDER_TIME_OUT_OF_RANGE). 광고성(MARKETING)은 마케팅 수신 동의가 있어야 켤 수 있음(400 NOTI_MARKETING_AGREEMENT_REQUIRED)',
  })
  @Put('settings')
  @ZodResponse(NotificationSettings)
  updateSettings(
    @ZodBody(UpdateNotificationSettings) body: z.infer<typeof UpdateNotificationSettings>,
    @CurrentUser() user: AuthUser,
  ) {
    return this.notifications.updateSettings(user, body);
  }

  @ApiOperation({ summary: '전체 읽음' })
  @Patch('read-all')
  @HttpCode(204)
  async readAll(@CurrentUser() user: AuthUser): Promise<void> {
    await this.notifications.readAll(user);
  }

  @ApiOperation({
    summary: '한 건 읽음',
    description: '푸시를 눌러 들어왔을 때도 호출. 남의 알림이면 404 NOTI_NOT_FOUND',
  })
  @Patch(':notificationId/read')
  @HttpCode(204)
  async read(
    @ZodParam('notificationId', z.uuid()) notificationId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.notifications.read(user, notificationId);
  }
}
