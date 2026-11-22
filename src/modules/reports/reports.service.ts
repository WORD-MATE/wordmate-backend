import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import { AppException } from '../../common/errors/app-exception.js';
import { kstDate } from '../../common/time/kst.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { isDuplicateKeyError } from '../../infra/db/errors.js';
import {
  battleResults,
  type Pack,
  packs,
  reportGroups,
  reports,
  users,
  words,
} from '../../infra/db/schema/index.js';
import { newId } from '../../infra/db/uuid.js';
import type { CreateReport } from './reports.schemas.js';

export const ReportErrors = {
  self: () =>
    new AppException(
      'REPORT_SELF',
      '자기 자신이나 내 단어팩은 신고할 수 없습니다.',
      HttpStatus.BAD_REQUEST,
    ),
  targetNotFound: () =>
    new AppException(
      'REPORT_TARGET_NOT_FOUND',
      '신고할 대상을 찾을 수 없습니다.',
      HttpStatus.NOT_FOUND,
    ),
  battleNotFound: () =>
    new AppException('BATTLE_NOT_FOUND', '참여한 대결을 찾을 수 없습니다.', HttpStatus.NOT_FOUND),
  duplicateToday: () =>
    new AppException(
      'REPORT_DUPLICATE_TODAY',
      '같은 대상을 같은 사유로 오늘 이미 신고했습니다.',
      HttpStatus.TOO_MANY_REQUESTS,
    ),
};

@Injectable()
export class ReportsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** 신고한 사람은 신고 대상에게 알리지 않는다 */
  async create(user: AuthUser, body: CreateReport): Promise<{ reportId: string }> {
    await this.assertTarget(user, body);
    if (body.battleId) await this.assertBattle(user, body.battleId);
    const reportId = newId();
    const now = new Date();
    try {
      await this.db.transaction(async (tx) => {
        // 대상의 열린 묶음에 넣는다. 없으면 만들고, 동시에 만들어도 유니크 키로 하나만 남는다
        await tx.insert(reportGroups).ignore().values({
          id: newId(),
          targetType: body.targetType,
          targetId: body.targetId,
          lastReportedAt: now,
        });
        const openGroup = and(
          eq(reportGroups.targetType, body.targetType),
          eq(reportGroups.targetId, body.targetId),
          eq(reportGroups.openKey, 1),
        );
        const [group] = await tx
          .select({ id: reportGroups.id, status: reportGroups.status })
          .from(reportGroups)
          .where(openGroup)
          .for('update');
        if (!group) throw new Error('열린 신고 묶음을 만들지 못했습니다.');
        await tx
          .update(reportGroups)
          .set({ lastReportedAt: now })
          .where(eq(reportGroups.id, group.id));
        await tx.insert(reports).values({
          id: reportId,
          groupId: group.id,
          status: group.status,
          reporterId: user.userId,
          targetType: body.targetType,
          targetId: body.targetId,
          reason: body.reason,
          detail: body.detail || null,
          battleId: body.battleId ?? null,
          reportDate: kstDate(),
        });
      });
    } catch (error) {
      if (isDuplicateKeyError(error, 'reports_daily_uq')) throw ReportErrors.duplicateToday();
      throw error;
    }
    return { reportId };
  }

  private async assertTarget(user: AuthUser, body: CreateReport): Promise<void> {
    if (body.targetType === 'USER') {
      if (body.targetId === user.userId) throw ReportErrors.self();
      const [target] = await this.db
        .select({ status: users.status })
        .from(users)
        .where(eq(users.id, body.targetId));
      if (!target || target.status === 'WITHDRAWN') throw ReportErrors.targetNotFound();
      return;
    }
    let packId = body.targetId;
    if (body.targetType === 'WORD') {
      const [word] = await this.db
        .select({ packId: words.packId })
        .from(words)
        .where(and(eq(words.id, body.targetId), isNull(words.deletedAt)));
      if (!word) throw ReportErrors.targetNotFound();
      packId = word.packId;
    }
    const [pack] = await this.db
      .select()
      .from(packs)
      .where(and(eq(packs.id, packId), isNull(packs.deletedAt)));
    if (!pack || !this.canSee(user, pack)) throw ReportErrors.targetNotFound();
    if (pack.ownerUserId === user.userId) throw ReportErrors.self();
  }

  // 남의 내 단어팩은 공유 코드로 공유됐을 때만 볼 수 있다
  private canSee(user: AuthUser, pack: Pack): boolean {
    return pack.type !== 'MINE' || pack.ownerUserId === user.userId || pack.shareCode !== null;
  }

  private async assertBattle(user: AuthUser, battleId: string): Promise<void> {
    const [row] = await this.db
      .select({ battleId: battleResults.battleId })
      .from(battleResults)
      .where(and(eq(battleResults.battleId, battleId), eq(battleResults.userId, user.userId)));
    if (!row) throw ReportErrors.battleNotFound();
  }
}
