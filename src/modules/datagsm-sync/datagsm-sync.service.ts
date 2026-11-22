import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { type Database, DB } from '../../infra/db/db.module.js';
import { classes, users } from '../../infra/db/schema/index.js';
import { DataGsmClient, type DataGsmStudent } from '../auth/datagsm/datagsm.client.js';
import { SessionService } from '../auth/session.service.js';
import { RankingService } from '../ranking/ranking.service.js';
import { classesOf, planSync } from './datagsm-sync.js';

/** 한 번에 맞춰 볼 학생 수 (임시값) */
export const SYNC_BATCH_SIZE = 200;

export interface SyncResult {
  fetched: number;
  matched: number;
  updated: number;
  deactivated: number;
  reactivated: number;
  classesCreated: number;
  skipped: number;
  failed: number;
}

@Injectable()
export class DataGsmSyncService {
  private readonly logger = new Logger(DataGsmSyncService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly datagsm: DataGsmClient,
    private readonly sessions: SessionService,
    private readonly ranking: RankingService,
  ) {}

  /**
   * 우리 서비스에 가입한 학생만 맞춘다 (가입하지 않은 학생은 만들지 않는다).
   * 목록에서 빠진 학생은 DataGSM 오류일 수 있어 휴면 처리하지 않고, 졸업·자퇴로 나온 학생만 휴면 처리한다
   */
  async sync(): Promise<SyncResult | { disabled: true }> {
    const students = await this.datagsm.listStudents();
    if (!students) {
      this.logger.warn('DATAGSM_API_KEY가 없어 학적 동기화를 건너뜁니다.');
      return { disabled: true };
    }

    const result: SyncResult = {
      fetched: students.length,
      matched: 0,
      updated: 0,
      deactivated: 0,
      reactivated: 0,
      classesCreated: await this.ensureClasses(students),
      skipped: 0,
      failed: 0,
    };

    for (let i = 0; i < students.length; i += SYNC_BATCH_SIZE) {
      const matches = await this.match(students.slice(i, i + SYNC_BATCH_SIZE));
      for (const [userId, student] of matches) {
        result.matched++;
        try {
          await this.apply(userId, student, result);
        } catch (error) {
          // 한 사용자 때문에 나머지가 매일 밀리지 않게 끝까지 돌고 실패로 남긴다
          result.failed++;
          this.logger.error(`학적 동기화 실패 (user ${userId}): ${String(error)}`);
        }
      }
    }
    if (result.failed > 0) {
      throw new Error(`${result.failed}명 반영 실패 (나머지 반영됨): ${JSON.stringify(result)}`);
    }
    return result;
  }

  private async ensureClasses(students: DataGsmStudent[]): Promise<number> {
    const rows = classesOf(students);
    if (rows.length === 0) return 0;
    const [result] = await this.db.insert(classes).ignore().values(rows);
    return result.affectedRows;
  }

  /** 학생 ID로 찾고, 아직 학생 ID가 없는 사용자(그 뒤로 로그인하지 않음)는 이메일로 찾는다 */
  private async match(batch: DataGsmStudent[]): Promise<Map<string, DataGsmStudent>> {
    const matches = new Map<string, DataGsmStudent>();
    const byStudentId = new Map(batch.flatMap((s) => (s.studentId ? [[s.studentId, s]] : [])));
    if (byStudentId.size > 0) {
      const rows = await this.db
        .select({ id: users.id, studentId: users.datagsmStudentId })
        .from(users)
        .where(
          and(eq(users.role, 'STUDENT'), inArray(users.datagsmStudentId, [...byStudentId.keys()])),
        );
      for (const row of rows) {
        const student = row.studentId ? byStudentId.get(row.studentId) : undefined;
        if (student) matches.set(row.id, student);
      }
    }

    const matched = new Set(matches.values());
    const byEmail = new Map(
      batch.flatMap((s) => (s.email && !matched.has(s) ? [[s.email.toLowerCase(), s]] : [])),
    );
    if (byEmail.size > 0) {
      const rows = await this.db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(
          and(
            eq(users.role, 'STUDENT'),
            isNull(users.datagsmStudentId),
            inArray(users.email, [...byEmail.keys()]),
          ),
        );
      // 같은 이메일의 계정이 여럿이면 누구인지 알 수 없어 맞추지 않는다
      const owners = new Map<string, string[]>();
      for (const row of rows) {
        if (!row.email) continue;
        const email = row.email.toLowerCase();
        owners.set(email, [...(owners.get(email) ?? []), row.id]);
      }
      for (const [email, ids] of owners) {
        const [only] = ids;
        const student = byEmail.get(email);
        if (student && only && ids.length === 1 && !matches.has(only)) matches.set(only, student);
      }
    }
    return matches;
  }

  private async apply(userId: string, student: DataGsmStudent, result: SyncResult): Promise<void> {
    const outcome = await this.db.transaction(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
      if (user?.role !== 'STUDENT') return null;
      const plan = planSync(user, student);
      if (!plan) return null;
      if (Object.keys(plan.changes).length > 0) {
        await tx.update(users).set(plan.changes).where(eq(users.id, userId));
      }
      if (plan.deactivate) await this.sessions.revokeAll(userId, tx);
      return { user, plan };
    });

    if (!outcome) {
      result.skipped++;
      return;
    }
    const { user, plan } = outcome;
    if (Object.keys(plan.changes).length > 0) result.updated++;
    if (plan.deactivate) result.deactivated++;
    if (plan.reactivate) result.reactivated++;
    if (plan.incomplete) result.skipped++;
    if (plan.classChanged) {
      await this.ranking.moveScopes(
        userId,
        { role: user.role, grade: user.grade, classNo: user.classNo },
        {
          role: user.role,
          grade: plan.changes.grade ?? user.grade,
          classNo: plan.changes.classNo ?? user.classNo,
        },
      );
    }
  }
}
