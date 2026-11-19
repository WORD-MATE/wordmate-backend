import { Controller, Delete, Get, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { SkipTermsCheck } from '../../common/auth/terms.decorator.js';
import type { ClientInfo } from '../../common/client/client.guard.js';
import { ZodBody, ZodParam, ZodResponse } from '../../common/zod/decorators.js';
import { DeviceList, RegisterDevice, RegisterDeviceResponse } from './devices.schemas.js';
import { DevicesService } from './devices.service.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;

@ApiTags('devices')
@Auth('USER')
@SkipTermsCheck()
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @ApiOperation({
    summary: '현재 기기 이름·푸시 정보 등록',
    description:
      '로그인 직후, 푸시 권한 허용 직후, 푸시 토큰이 바뀔 때 호출. 푸시를 끄면 pushType=null로 다시 호출',
  })
  @Post()
  @HttpCode(200)
  @ZodResponse(RegisterDeviceResponse)
  register(@ZodBody(RegisterDevice) body: RegisterDevice, @Req() request: FastifyRequest) {
    const { platform } = request.client as ClientInfo;
    return this.devices.register(currentUser(request), platform, body);
  }

  @ApiOperation({ summary: '로그인한 기기 목록' })
  @Get()
  @ZodResponse(DeviceList)
  list(@Req() request: FastifyRequest) {
    return this.devices.list(currentUser(request));
  }

  @ApiOperation({
    summary: '원격 로그아웃',
    description: '해당 기기의 리프레시 토큰과 푸시 등록을 폐기. 액세스 토큰이 만료되면 로그아웃됨',
  })
  @Delete(':deviceId')
  @HttpCode(204)
  async remove(
    @ZodParam('deviceId', z.uuid()) deviceId: string,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    await this.devices.remove(currentUser(request), deviceId);
  }
}
