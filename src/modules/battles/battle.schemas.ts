import { z } from 'zod';
import { PARTICIPANT_STATE, ROOM_STATUS, ROOM_TYPE } from '../../common/enums.js';
import { UserSummary } from '../users/user-summary.js';

export const BATTLE_QUESTION_TYPES = ['EN_TO_KO_CHOICE', 'KO_TO_EN_CHOICE'] as const;
export const BATTLE_QUESTION_COUNTS = [10, 20, 30] as const;
export const BATTLE_TIME_LIMITS = [5, 10, 15] as const;
export const INVITE_CODE_PATTERN = /^[A-Z0-9]{6}$/;

export const CreateRoom = z
  .object({
    packId: z.uuid().describe('기본 단어팩이나 내 단어팩, 단어 10개 이상'),
    questionType: z.enum(BATTLE_QUESTION_TYPES).describe('4지선다만'),
    questionCount: z.union(BATTLE_QUESTION_COUNTS.map((count) => z.literal(count))),
    timeLimitSec: z.union(BATTLE_TIME_LIMITS.map((seconds) => z.literal(seconds))),
    maxParticipants: z.number().int().min(2).max(30),
  })
  .meta({ id: 'CreateRoom' });
export type CreateRoom = z.infer<typeof CreateRoom>;

export const Participant = z
  .object({
    user: UserSummary,
    state: z.enum(PARTICIPANT_STATE),
    isHost: z.boolean(),
    joinedAt: z.iso.datetime(),
  })
  .meta({ id: 'Participant' });

export const Room = z
  .object({
    roomId: z.string(),
    inviteCode: z.string(),
    inviteUrl: z.string(),
    type: z.enum(ROOM_TYPE),
    status: z.enum(ROOM_STATUS),
    hostUserId: z.string().nullable().describe('교사용 반 방은 교사'),
    classId: z.string().nullable().describe('교사용 반 방만'),
    settings: z.object({
      packId: z.string(),
      packName: z.string(),
      questionType: z.enum(BATTLE_QUESTION_TYPES),
      questionCount: z.number().int(),
      timeLimitSec: z.number().int(),
      maxParticipants: z.number().int(),
    }),
    participants: z
      .array(Participant)
      .describe('방에 남아 있는 참가자 (교사용 반 방의 교사는 진행자라 들어가지 않음)'),
    duplicateQuestions: z.boolean().describe('단어 수가 문항 수보다 적어 같은 단어가 다시 나옴'),
    battleId: z
      .string()
      .nullable()
      .describe('대결이 시작되면 생긴다. 끝난 뒤 결과 조회(GET /battles/{battleId}/result)에 쓴다'),
    expiresAt: z.iso.datetime().describe('이때까지 시작하지 않으면 방이 닫힘'),
  })
  .meta({ id: 'Room' });
export type Room = z.infer<typeof Room>;
