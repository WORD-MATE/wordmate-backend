import { Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Auth } from '../../common/auth/auth.decorator.js';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { ZodBody, ZodParam, ZodResponse } from '../../common/zod/decorators.js';
import { CreateRoom, Room } from './battle.schemas.js';
import {
  JOIN_FAIL_LIMIT,
  JOIN_FAIL_WINDOW_SECONDS,
  MIN_BATTLE_WORDS,
  RoomErrors,
  RoomsService,
} from './rooms.service.js';

const currentUser = (request: FastifyRequest): AuthUser => request.user as AuthUser;

@ApiTags('battles')
@Controller('battles/rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @ApiOperation({
    summary: '대결방 만들기',
    description: `만든 사람이 방장. 단어 ${MIN_BATTLE_WORDS}개 이상인 팩, 4지선다만. 단어 수가 문항 수보다 적으면 중복 출제(duplicateQuestions). 30분 안에 시작하지 않으면 닫힘. 사용자당 활성 방 하나(409 ROOM_ALREADY_JOINED, detail.inviteCode). 교사는 POST /classes/{classId}/rooms`,
  })
  @Auth('STUDENT')
  @Post()
  @ZodResponse(Room, { status: 201 })
  create(@ZodBody(CreateRoom) body: z.infer<typeof CreateRoom>, @Req() request: FastifyRequest) {
    return this.rooms.create(currentUser(request), body);
  }

  @ApiOperation({
    summary: '대결방 조회 (초대 링크)',
    description:
      '상태에 따라 대기실·진행·결과 화면으로 분기. 그 코드로 진행 중인 방이 없으면 가장 최근 방',
  })
  @Get(':inviteCode')
  @ZodResponse(Room)
  get(@Param('inviteCode') inviteCode: string) {
    return this.rooms.get(inviteCode);
  }

  @ApiOperation({
    summary: '대결방 참가',
    description: `참가 후 WebSocket ROOM_SUBSCRIBE. 이미 들어와 있으면 그대로 200. 코드를 ${JOIN_FAIL_LIMIT}번 연달아 잘못 넣으면 ${JOIN_FAIL_WINDOW_SECONDS}초 제한(429, Retry-After)`,
  })
  @Auth('STUDENT')
  @Post(':inviteCode/join')
  @ZodResponse(Room)
  async join(
    @Param('inviteCode') inviteCode: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const user = currentUser(request);
    if (await this.rooms.isJoinBlocked(user.userId)) {
      reply.header('Retry-After', String(JOIN_FAIL_WINDOW_SECONDS));
      throw RoomErrors.attemptsExceeded();
    }
    return this.rooms.join(user, inviteCode);
  }
}

@ApiTags('battles')
@Controller('classes')
export class ClassRoomsController {
  constructor(private readonly rooms: RoomsService) {}

  @ApiOperation({
    summary: '교사용 반 대결방 만들기',
    description:
      '담당 반 학생만 들어올 수 있음. 교사는 진행자라 참가자·점수에 들어가지 않음. 진행 중인 반 방은 교사당 하나',
  })
  @Auth('TEACHER')
  @Post(':classId/rooms')
  @ZodResponse(Room, { status: 201 })
  create(
    @ZodParam('classId', z.uuid()) classId: string,
    @ZodBody(CreateRoom) body: z.infer<typeof CreateRoom>,
    @Req() request: FastifyRequest,
  ) {
    return this.rooms.createForClass(currentUser(request), classId, body);
  }
}
