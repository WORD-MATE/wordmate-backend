import type { Job } from '../../common/enums.js';

/** 작업마다 큐·스케줄 이름과 사람이 읽는 주기 (KST) */
export const JOB_DEFINITIONS: Record<Job, { queue: string; name: string; schedule: string }> = {
  EXPIRE_STUDY_SESSIONS: {
    queue: 'maintenance',
    name: 'expire-study-sessions',
    schedule: '매시 5분',
  },
  DAILY_CLEANUP: { queue: 'maintenance', name: 'daily-cleanup', schedule: '매일 03:00' },
  SEASON_CLOSE: { queue: 'ranking', name: 'close-seasons', schedule: '매시 10분' },
  CHALLENGE_GENERATE: { queue: 'challenge', name: 'generate-challenge', schedule: '매일 23:50' },
  STUDY_REMINDER: { queue: 'scheduled-notifications', name: 'study-reminder', schedule: '매분' },
  MORNING_PUBLISH: {
    queue: 'scheduled-notifications',
    name: 'morning-publish',
    schedule: '매일 06:00',
  },
  MORNING_SENTENCE: {
    queue: 'scheduled-notifications',
    name: 'morning-sentence',
    schedule: '매일 07:00',
  },
  RANK_WEEKLY_RESULT: {
    queue: 'scheduled-notifications',
    name: 'rank-weekly-result',
    schedule: '월요일 08:00~12:00 매시',
  },
  RANK_DROP: { queue: 'scheduled-notifications', name: 'rank-drop', schedule: '매일 20:00' },
};

export const JOB_QUEUES = [...new Set(Object.values(JOB_DEFINITIONS).map((d) => d.queue))];

/** 큐의 작업 이름으로 찾는다 */
export function jobOf(queue: string, name: string): Job | null {
  const found = Object.entries(JOB_DEFINITIONS).find(
    ([, d]) => d.queue === queue && d.name === name,
  );
  return found ? (found[0] as Job) : null;
}

/** 관리자가 직접 실행한 작업인지 */
export const triggerOf = (data: unknown) =>
  (data as { manual?: boolean } | undefined)?.manual === true
    ? ('MANUAL' as const)
    : ('SCHEDULE' as const);
