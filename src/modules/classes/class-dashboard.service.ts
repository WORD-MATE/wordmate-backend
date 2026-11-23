import { Inject, Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  inArray,
  lt,
  lte,
  max,
  sql,
  sum,
} from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import type { DashboardPeriod } from '../../common/enums.js';
import { kstDate, kstMonthRange, kstWeekRange } from '../../common/time/kst.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import {
  battleResults,
  classes,
  dailyStudiedWords,
  dailyStudyStats,
  studyRecords,
  teacherClasses,
  userStreaks,
  users,
  words,
  wrongNotes,
} from '../../infra/db/schema/index.js';
import type { ClassSummary } from '../users/me.schema.js';
import { toUserSummary } from '../users/user-summary.js';
import {
  classSummary,
  NO_ACTIVITY,
  type StudentActivity,
  studentMetrics,
} from './class-dashboard.js';
import type { ClassDashboard } from './classes.schemas.js';
import { ClassErrors } from './classes.service.js';

export const FREQUENT_WRONG_WORD_LIMIT = 10;

@Injectable()
export class ClassDashboardService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async students(user: AuthUser, classId: string) {
    const found = await this.accessible(user, classId);
    const members = await this.members(found);
    const ids = members.map((m) => m.id);
    const last =
      ids.length === 0
        ? []
        : await this.db
            .select({ userId: studyRecords.userId, at: max(studyRecords.completedAt) })
            .from(studyRecords)
            .where(inArray(studyRecords.userId, ids))
            .groupBy(studyRecords.userId);
    const lastOf = new Map(last.map((row) => [row.userId, row.at]));
    return members.map((member) => {
      const at = lastOf.get(member.id);
      return {
        user: toUserSummary(member),
        studentNumber: member.studentNumber,
        number: member.number,
        lastStudiedAt: at ? new Date(at).toISOString() : null,
      };
    });
  }

  /** 반 학생 수만큼만 모으므로 캐시 없이 바로 집계한다 (반 대결 직후에도 바로 보이게) */
  async dashboard(
    user: AuthUser,
    classId: string,
    period: DashboardPeriod,
  ): Promise<ClassDashboard> {
    const found = await this.accessible(user, classId);
    const members = await this.members(found);
    const ids = members.map((m) => m.id);
    const today = kstDate();
    const range = period === 'WEEK' ? kstWeekRange(today) : kstMonthRange(today);
    const from = kstDate(range.start);

    const activity = ids.length === 0 ? new Map() : await this.activity(ids, from, today, range);
    const students = members.map((member) => ({
      user: toUserSummary(member),
      studentNumber: member.studentNumber,
      ...studentMetrics(activity.get(member.id) ?? NO_ACTIVITY, today),
    }));
    return {
      class: found,
      period,
      from,
      to: today,
      summary: classSummary(students),
      students,
      frequentWrongWords: ids.length === 0 ? [] : await this.frequentWrongWords(ids, range.start),
    };
  }

  /** 교사는 담당 반만, 관리자는 학생이어도 모든 반을 본다 */
  private async accessible(user: AuthUser, classId: string): Promise<ClassSummary> {
    const [found] = await this.db
      .select({ classId: classes.id, grade: classes.grade, classNo: classes.classNo })
      .from(classes)
      .where(eq(classes.id, classId));
    if (!found) throw ClassErrors.missing();
    if (user.isAdmin) return found;
    const [assigned] = await this.db
      .select({ classId: teacherClasses.classId })
      .from(teacherClasses)
      .where(and(eq(teacherClasses.teacherId, user.userId), eq(teacherClasses.classId, classId)));
    if (!assigned) throw ClassErrors.notAssigned();
    return found;
  }

  /** 졸업·자퇴(휴면)와 탈퇴는 반에서 빼고, 정지 중인 학생은 반 구성원으로 남긴다 */
  private members(found: ClassSummary) {
    return this.db
      .select()
      .from(users)
      .where(
        and(
          eq(users.role, 'STUDENT'),
          eq(users.grade, found.grade),
          eq(users.classNo, found.classNo),
          inArray(users.status, ['ACTIVE', 'SUSPENDED']),
        ),
      )
      .orderBy(sql`${users.number} IS NULL`, asc(users.number), asc(users.studentNumber));
  }

  private async activity(
    ids: string[],
    from: string,
    today: string,
    range: { start: Date; end: Date },
  ): Promise<Map<string, StudentActivity>> {
    const [study, studied, streaks, battles] = await Promise.all([
      this.db
        .select({
          userId: dailyStudyStats.userId,
          solved: sum(dailyStudyStats.solvedCount),
          graded: sum(dailyStudyStats.gradedCount),
          correct: sum(dailyStudyStats.correctCount),
        })
        .from(dailyStudyStats)
        .where(
          and(
            inArray(dailyStudyStats.userId, ids),
            gte(dailyStudyStats.date, from),
            lte(dailyStudyStats.date, today),
          ),
        )
        .groupBy(dailyStudyStats.userId),
      this.db
        .select({
          userId: dailyStudiedWords.userId,
          count: countDistinct(dailyStudiedWords.wordId),
        })
        .from(dailyStudiedWords)
        .where(
          and(
            inArray(dailyStudiedWords.userId, ids),
            gte(dailyStudiedWords.date, from),
            lte(dailyStudiedWords.date, today),
          ),
        )
        .groupBy(dailyStudiedWords.userId),
      this.db
        .select()
        .from(userStreaks)
        .where(and(inArray(userStreaks.userId, ids), eq(userStreaks.kind, 'STUDY'))),
      this.db
        .select({
          userId: battleResults.userId,
          total: count(),
          wins: sum(sql`${battleResults.outcome} = 'WIN'`),
        })
        .from(battleResults)
        .where(
          and(
            inArray(battleResults.userId, ids),
            gte(battleResults.finishedAt, range.start),
            lt(battleResults.finishedAt, range.end),
          ),
        )
        .groupBy(battleResults.userId),
    ]);

    const result = new Map<string, StudentActivity>();
    const entry = (userId: string) => {
      let value = result.get(userId);
      if (!value) {
        value = { ...NO_ACTIVITY };
        result.set(userId, value);
      }
      return value;
    };
    for (const row of study) {
      Object.assign(entry(row.userId), {
        solvedCount: Number(row.solved ?? 0),
        gradedCount: Number(row.graded ?? 0),
        correctCount: Number(row.correct ?? 0),
      });
    }
    for (const row of studied) entry(row.userId).studiedWordCount = row.count;
    for (const row of streaks) entry(row.userId).streak = row;
    for (const row of battles) {
      Object.assign(entry(row.userId), {
        battleCount: row.total,
        battleWinCount: Number(row.wins ?? 0),
      });
    }
    return result;
  }

  /** 오답노트는 틀릴 때마다 last_wrong_at을 갱신하므로, 그 값이 기간 안이면 기간 안에 틀린 것이다 */
  private async frequentWrongWords(ids: string[], start: Date) {
    const wrongStudentCount = countDistinct(wrongNotes.userId);
    const top = await this.db
      .select({ wordId: wrongNotes.wordId, wrongStudentCount })
      .from(wrongNotes)
      .where(and(inArray(wrongNotes.userId, ids), gte(wrongNotes.lastWrongAt, start)))
      .groupBy(wrongNotes.wordId)
      .orderBy(desc(wrongStudentCount), asc(wrongNotes.wordId))
      .limit(FREQUENT_WRONG_WORD_LIMIT);
    if (top.length === 0) return [];
    const found = await this.db
      .select({ id: words.id, english: words.english, meanings: words.meanings })
      .from(words)
      .where(
        inArray(
          words.id,
          top.map((row) => row.wordId),
        ),
      );
    const wordOf = new Map(found.map((word) => [word.id, word]));
    return top.flatMap((row) => {
      const word = wordOf.get(row.wordId);
      return word
        ? [
            {
              wordId: row.wordId,
              english: word.english,
              meanings: word.meanings,
              wrongStudentCount: row.wrongStudentCount,
            },
          ]
        : [];
    });
  }
}
