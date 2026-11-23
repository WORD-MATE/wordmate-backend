import { z } from 'zod';
import { BATTLE_OUTCOME, PARTICIPANT_STATE, ROOM_STATUS, ROOM_TYPE } from '../../common/enums.js';
import { CursorQuery, cursorPage } from '../../common/pagination.js';
import { XpResult } from '../study/study.schemas.js';
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

export const BattleResult = z
  .object({
    battleId: z.string(),
    roomType: z.enum(ROOM_TYPE),
    finishedAt: z.iso.datetime(),
    settings: Room.shape.settings,
    ranking: z
      .array(
        z.object({
          rank: z.number().int().nullable().describe('중도 이탈은 null (맨 아래)'),
          user: UserSummary,
          score: z.number().int(),
          correctCount: z.number().int(),
          totalTimeMs: z.number().int(),
          outcome: z.enum(BATTLE_OUTCOME),
        }),
      )
      .describe('순위순, 같으면 총 풀이 시간 짧은 순'),
    me: z
      .object({
        rank: z.number().int().nullable(),
        score: z.number().int(),
        outcome: z.enum(BATTLE_OUTCOME),
        xp: XpResult,
      })
      .nullable()
      .describe('참가하지 않은 진행자(교사)는 null'),
    questions: z.array(
      z.object({
        index: z.number().int(),
        word: z.object({
          wordId: z.string(),
          english: z.string(),
          meanings: z.array(z.string()),
          example: z.string().nullable(),
        }),
        choices: z.array(z.string()),
        answerIndex: z.number().int(),
        myChoiceIndex: z.number().int().nullable().describe('미응답이면 null'),
        correct: z.boolean().nullable().describe('진행자(교사)는 null'),
      }),
    ),
  })
  .meta({ id: 'BattleResult' });
export type BattleResult = z.infer<typeof BattleResult>;

export const BattleHistoryQuery = CursorQuery;
export type BattleHistoryQuery = z.infer<typeof BattleHistoryQuery>;

export const BattleHistoryItem = z.object({
  battleId: z.string(),
  finishedAt: z.iso.datetime(),
  packName: z.string(),
  participantCount: z.number().int(),
  rank: z.number().int().nullable().describe('중도 이탈은 null'),
  score: z.number().int(),
  outcome: z.enum(BATTLE_OUTCOME),
});
export type BattleHistoryItem = z.infer<typeof BattleHistoryItem>;

export const BattleHistory = cursorPage(BattleHistoryItem)
  .extend({
    summary: z.object({
      total: z.number().int(),
      winRate: z
        .number()
        .nullable()
        .describe('1위 횟수 / 완주한 대결 수 (0~1), 완주한 대결이 없으면 null'),
      avgAccuracy: z
        .number()
        .nullable()
        .describe('완주한 대결의 평균 정답률 (0~1), 완주한 대결이 없으면 null'),
    }),
  })
  .meta({ id: 'BattleHistory' });
export type BattleHistory = z.infer<typeof BattleHistory>;
