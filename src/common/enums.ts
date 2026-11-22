type Values<T extends readonly string[]> = T[number];

export const ROLE = ['STUDENT', 'TEACHER'] as const;
export type Role = Values<typeof ROLE>;

export const ACCOUNT_STATUS = ['ACTIVE', 'SUSPENDED', 'INACTIVE', 'WITHDRAWN'] as const;
export type AccountStatus = Values<typeof ACCOUNT_STATUS>;

export const PLATFORM = ['IOS', 'ANDROID', 'WEB'] as const;
export type Platform = Values<typeof PLATFORM>;

export const PUSH_TYPE = ['APNS', 'FCM', 'WEBPUSH'] as const;
export type PushType = Values<typeof PUSH_TYPE>;

export const NEXT_STEP = ['TERMS_AGREEMENT', 'TEACHER_CLASS_SELECT', 'HOME'] as const;
export type NextStep = Values<typeof NEXT_STEP>;

export const AUDIT_ACTION = ['TEACHER_CLASS_CHANGE'] as const;
export type AuditAction = Values<typeof AUDIT_ACTION>;

export const UPDATE_STATUS = ['NONE', 'RECOMMENDED', 'REQUIRED'] as const;
export type UpdateStatus = Values<typeof UPDATE_STATUS>;

export const POLICY_TYPE = ['TERMS', 'PRIVACY', 'MARKETING'] as const;
export type PolicyType = Values<typeof POLICY_TYPE>;

export const PACK_TYPE = ['DEFAULT', 'MINE'] as const;
export type PackType = Values<typeof PACK_TYPE>;

export const PACK_SORT = ['RECOMMENDED', 'NAME', 'RECENT'] as const;
export type PackSort = Values<typeof PACK_SORT>;

export const DUPLICATE_POLICY = ['SKIP', 'OVERWRITE'] as const;
export type DuplicatePolicy = Values<typeof DUPLICATE_POLICY>;

export const MEMORY_STATUS = ['NEW', 'LEARNING', 'MEMORIZED'] as const;
export type MemoryStatus = Values<typeof MEMORY_STATUS>;

export const QUIZ_MODE = ['FLASHCARD', 'CHOICE', 'TYPING'] as const;
export type QuizMode = Values<typeof QUIZ_MODE>;

export const QUIZ_DIRECTION = ['EN_TO_KO', 'KO_TO_EN'] as const;
export type QuizDirection = Values<typeof QUIZ_DIRECTION>;

export const QUESTION_TYPE = [
  'EN_TO_KO_CHOICE',
  'KO_TO_EN_CHOICE',
  'EN_TO_KO_TYPING',
  'KO_TO_EN_TYPING',
] as const;
export type QuestionType = Values<typeof QUESTION_TYPE>;

export const STUDY_SOURCE = ['PACK', 'WRONG_NOTE', 'FAVORITE', 'REVIEW', 'RECORD_WRONG'] as const;
export type StudySource = Values<typeof STUDY_SOURCE>;

export const STUDY_SESSION_STATUS = ['IN_PROGRESS', 'COMPLETED', 'ABANDONED'] as const;
export type StudySessionStatus = Values<typeof STUDY_SESSION_STATUS>;

export const STUDY_END_REASON = ['FINISHED', 'QUIT'] as const;
export type StudyEndReason = Values<typeof STUDY_END_REASON>;

export const STREAK_KIND = ['STUDY', 'MORNING'] as const;
export type StreakKind = Values<typeof STREAK_KIND>;

export const WRONG_NOTE_STATUS = ['ACTIVE', 'GRADUATED'] as const;
export type WrongNoteStatus = Values<typeof WRONG_NOTE_STATUS>;

export const WRONG_SOURCE = ['STUDY', 'BATTLE', 'MORNING'] as const;
export type WrongSource = Values<typeof WRONG_SOURCE>;

export const WRONG_SORT = ['RECENT', 'MOST_WRONG'] as const;
export type WrongSort = Values<typeof WRONG_SORT>;

export const STATS_PERIOD = ['TODAY', 'WEEK', 'MONTH'] as const;
export type StatsPeriod = Values<typeof STATS_PERIOD>;

export const MORNING_QUIZ_TYPE = ['FILL_BLANK', 'MEANING', 'QUESTION'] as const;
export type MorningQuizType = Values<typeof MORNING_QUIZ_TYPE>;

export const MORNING_STATUS = ['PENDING_REVIEW', 'SCHEDULED', 'PUBLISHED'] as const;
export type MorningStatus = Values<typeof MORNING_STATUS>;

export const ROOM_TYPE = ['NORMAL', 'CLASS', 'QUICK_MATCH'] as const;
export type RoomType = Values<typeof ROOM_TYPE>;

export const ROOM_STATUS = ['WAITING', 'COUNTDOWN', 'IN_PROGRESS', 'FINISHED', 'EXPIRED'] as const;
export type RoomStatus = Values<typeof ROOM_STATUS>;

/** 대결 한 판의 진행 단계: 문항 풀이 중 → 결과 표시(2초) → 다음 문항 … → 끝 */
export const BATTLE_PHASE = ['READY', 'QUESTION', 'RESULT', 'FINISHED'] as const;
export type BattlePhase = Values<typeof BATTLE_PHASE>;

export const PARTICIPANT_STATE = ['CONNECTED', 'DISCONNECTED', 'LEFT', 'KICKED'] as const;
export type ParticipantState = Values<typeof PARTICIPANT_STATE>;

export const BATTLE_OUTCOME = ['WIN', 'DRAW', 'LOSE', 'LEFT', 'WIN_BY_FORFEIT'] as const;
export type BattleOutcome = Values<typeof BATTLE_OUTCOME>;

export const REACTION = ['LIKE', 'FIRE', 'CLAP', 'LAUGH', 'WOW', 'CRY'] as const;
export type Reaction = Values<typeof REACTION>;

export const RANK_PERIOD = ['WEEKLY', 'MONTHLY', 'ALL'] as const;
export type RankPeriod = Values<typeof RANK_PERIOD>;

export const RANK_SCOPE = ['SCHOOL', 'GRADE', 'CLASS', 'FRIENDS'] as const;
export type RankScope = Values<typeof RANK_SCOPE>;

export const XP_SOURCE = [
  'STUDY',
  'PACK_COMPLETE',
  'BATTLE',
  'MORNING',
  'MISSION',
  'CHALLENGE',
  'WRONG_NOTE_REVIEW',
  'ADMIN_ADJUST',
] as const;
export type XpSource = Values<typeof XP_SOURCE>;

export const XP_BLOCK_REASON = [
  'DAILY_CAP',
  'REPEAT_LIMIT',
  'FORFEIT',
  'TOO_FAST',
  'NOT_COMPLETED',
] as const;
export type XpBlockReason = Values<typeof XP_BLOCK_REASON>;

export const MISSION_PERIOD = ['DAILY', 'WEEKLY'] as const;
export type MissionPeriod = Values<typeof MISSION_PERIOD>;

/** 미션이 세는 활동 */
export const MISSION_METRIC = [
  'STUDY_COMPLETE',
  'WORDS_STUDIED',
  'BATTLE_FINISH',
  'BATTLE_WIN',
  'MORNING_COMPLETE',
  'XP_EARNED',
] as const;
export type MissionMetric = Values<typeof MISSION_METRIC>;

export const MISSION_STATUS = ['IN_PROGRESS', 'CLAIMABLE', 'CLAIMED', 'EXPIRED'] as const;
export type MissionStatus = Values<typeof MISSION_STATUS>;

export const BADGE_TYPE = ['ACHIEVEMENT', 'SEASON'] as const;
export type BadgeType = Values<typeof BADGE_TYPE>;

export const FRIEND_REQUEST_DIRECTION = ['RECEIVED', 'SENT'] as const;
export type FriendRequestDirection = Values<typeof FRIEND_REQUEST_DIRECTION>;

export const REPORT_TARGET = ['USER', 'PACK', 'WORD'] as const;
export type ReportTarget = Values<typeof REPORT_TARGET>;

export const REPORT_REASON = [
  'INAPPROPRIATE_CONTENT',
  'OFFENSIVE_REACTION',
  'CHEATING',
  'OTHER',
] as const;
export type ReportReason = Values<typeof REPORT_REASON>;

export const REPORT_STATUS = ['RECEIVED', 'IN_REVIEW', 'RESOLVED'] as const;
export type ReportStatus = Values<typeof REPORT_STATUS>;

export const REPORT_RESULT = ['DISMISSED', 'WARNING', 'SANCTIONED'] as const;
export type ReportResult = Values<typeof REPORT_RESULT>;

export const SANCTION_TYPE = ['WARNING', 'XP_REVOKE', 'SUSPEND', 'BAN'] as const;
export type SanctionType = Values<typeof SANCTION_TYPE>;

export const NOTIFICATION_CATEGORY = [
  'STUDY_REMINDER',
  'MORNING_SENTENCE',
  'BATTLE',
  'RANKING',
  'NOTICE',
  'MARKETING',
] as const;
export type NotificationCategory = Values<typeof NOTIFICATION_CATEGORY>;

export const NOTIFICATION_TYPE = [
  'BATTLE_INVITE',
  'BATTLE_RESULT',
  'RANK_DROP',
  'RANK_WEEKLY_RESULT',
  'STUDY_REMINDER',
  'MORNING_SENTENCE',
  'NOTICE',
  'MARKETING',
  'INQUIRY_ANSWERED',
  'FRIEND_REQUEST',
  'FRIEND_ACCEPTED',
  'BADGE_EARNED',
  'SANCTION',
  'REPORT_RESULT',
  'NEW_DEVICE_LOGIN',
  'ADMIN_ALERT',
] as const;
export type NotificationType = Values<typeof NOTIFICATION_TYPE>;

export const WEEKDAY = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Weekday = Values<typeof WEEKDAY>;

export const INQUIRY_TYPE = ['ACCOUNT', 'STUDY', 'BATTLE_RANKING', 'BUG', 'OTHER'] as const;
export type InquiryType = Values<typeof INQUIRY_TYPE>;

export const INQUIRY_STATUS = ['RECEIVED', 'ANSWERED'] as const;
export type InquiryStatus = Values<typeof INQUIRY_STATUS>;

export const FAQ_CATEGORY = ['ACCOUNT', 'STUDY', 'BATTLE_RANKING', 'OTHER'] as const;
export type FaqCategory = Values<typeof FAQ_CATEGORY>;

export const FORBIDDEN_WORD_TYPE = ['FORBIDDEN', 'ALLOWED'] as const;
export type ForbiddenWordType = Values<typeof FORBIDDEN_WORD_TYPE>;

export const SEASON_PERIOD = ['WEEKLY', 'MONTHLY'] as const;
export type SeasonPeriod = Values<typeof SEASON_PERIOD>;

export const SEASON_STATUS = ['CLOSED_PENDING', 'CONFIRMED', 'FAILED'] as const;
export type SeasonStatus = Values<typeof SEASON_STATUS>;

export const JOB = [
  'DATAGSM_SYNC',
  'SEASON_CLOSE',
  'STUDY_REMINDER',
  'MORNING_PUBLISH',
  'RANKING_SNAPSHOT',
] as const;
export type Job = Values<typeof JOB>;
