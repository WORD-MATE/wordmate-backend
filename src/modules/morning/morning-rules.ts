import { kstDate } from '../../common/time/kst.js';

/** 오늘의 문장은 06:00 KST에 바뀐다. 그 전에는 전날 문장이 "오늘" */
export const MORNING_DAY_START_HOUR = 6;
/** 오늘 문장 퀴즈를 처음 끝냈을 때 XP (임시값) */
export const MORNING_XP = 10;

export function morningDate(now: Date = new Date()): string {
  return kstDate(new Date(now.getTime() - MORNING_DAY_START_HOUR * 60 * 60 * 1000));
}

const normalize = (value: string) => value.trim().toLowerCase();

/** 앞뒤 공백을 지우고 대소문자를 무시해 허용 정답 중 하나와 같으면 정답 */
export function isCorrectAnswer(accepted: string[], answer: string): boolean {
  const given = normalize(answer);
  return accepted.some((value) => normalize(value) === given);
}
