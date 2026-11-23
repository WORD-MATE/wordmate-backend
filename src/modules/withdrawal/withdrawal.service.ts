import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { AccountBlockService } from '../../common/auth/account-block.service.js';
import { AuthErrors } from '../../common/auth/auth-errors.js';
import { AppException } from '../../common/errors/app-exception.js';
import { type Database, DB, type Transaction } from '../../infra/db/db.module.js';
import {
  battleDailyPairs,
  battleRoomParticipants,
  battleRooms,
  blocks,
  challengeAttempts,
  dailyStudiedWords,
  dailyStudyStats,
  devices,
  friendRequests,
  friendships,
  inquiries,
  inquiryImages,
  morningCompletions,
  noticeReads,
  notificationSettings,
  notifications,
  packCopies,
  packs,
  practiceSessions,
  rankingSeasonExclusions,
  rankingSnapshots,
  studyRecords,
  studySessions,
  suspiciousFlags,
  teacherClasses,
  userAgreements,
  userBadges,
  userMissions,
  userStreaks,
  users,
  userWordProgress,
  withdrawnSuspensions,
  wordFavorites,
  words,
  wrongNotes,
  xpLedger,
} from '../../infra/db/schema/index.js';
import { LobbyService } from '../battles/lobby.service.js';
import { MatchQueue } from '../battles/match-queue.js';
import { RankingService } from '../ranking/ranking.service.js';
import { InquiryImageStorage } from '../support/inquiry-image.storage.js';
import { anonymizedUser, isLastActiveAdmin, withdrawnSuspensionOf } from './withdrawal-rules.js';

export const WithdrawalErrors = {
  notConfirmed: () =>
    new AppException(
      'USER_WITHDRAW_NOT_CONFIRMED',
      '탈퇴하려면 확인이 필요합니다.',
      HttpStatus.BAD_REQUEST,
    ),
  lastAdmin: () =>
    new AppException(
      'USER_LAST_ADMIN',
      '마지막 관리자는 탈퇴할 수 없습니다. 다른 관리자를 먼저 지정해 주세요.',
      HttpStatus.CONFLICT,
    ),
};

const ACTIVE_ROOM_STATUS = ['WAITING', 'COUNTDOWN', 'IN_PROGRESS'] as const;

@Injectable()
export class WithdrawalService {
  private readonly logger = new Logger(WithdrawalService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly accountBlocks: AccountBlockService,
    private readonly ranking: RankingService,
    private readonly lobby: LobbyService,
    private readonly matchQueue: MatchQueue,
    private readonly images: InquiryImageStorage,
  ) {}

  /**
   * 유예 없이 바로 파기한다. 본인만 쓰던 데이터는 지우고, 끝난 대결처럼 다른 사람의 기록이 참조하는 행은
   * 남겨 "탈퇴한 사용자"로 보이게 한다. DB는 한 트랜잭션으로, Valkey·파일·대결방 정리는 커밋한 뒤에 한다
   */
  async withdraw(userId: string): Promise<void> {
    const now = new Date();
    const [current] = await this.db
      .select({ isAdmin: users.isAdmin })
      .from(users)
      .where(eq(users.id, userId));
    // 커밋과 차단 사이에 실패해 남은 토큰이 살아 있지 않도록 먼저 막고, 롤백되면 되돌린다
    await this.accountBlocks.block(userId, 'WITHDRAWN');

    const result = await this.db
      .transaction((tx) => this.destroy(tx, userId, now, current?.isAdmin ?? false))
      .catch(async (error: unknown) => {
        await this.restoreBlock(userId).catch(() => undefined);
        throw error;
      });

    await this.ranking.removeUser(userId, result.user, now);
    await this.images
      .remove(result.imageKeys)
      .catch((error: unknown) => this.logger.warn(`문의 이미지 삭제 실패: ${String(error)}`));
    await this.matchQueue.remove(userId).catch(() => undefined);
    await this.leaveRooms(userId);
  }

  /** 실패한 뒤 차단은 지금 상태에 맞춘다 (동시에 다른 탈퇴가 커밋됐으면 탈퇴 차단을 그대로 둔다) */
  private async restoreBlock(userId: string): Promise<void> {
    const [row] = await this.db
      .select({ status: users.status })
      .from(users)
      .where(eq(users.id, userId));
    if (row?.status === 'WITHDRAWN') await this.accountBlocks.block(userId, 'WITHDRAWN');
    else if (row?.status === 'SUSPENDED') await this.accountBlocks.block(userId);
    else await this.accountBlocks.unblock(userId);
  }

  private async destroy(tx: Transaction, userId: string, now: Date, wasAdmin: boolean) {
    // 관리자는 권한 변경(setAdmin)과 같은 순서로 관리자 행을 먼저 잠근 뒤 자기 행을 잠근다
    const lockAdmins = () =>
      tx
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.isAdmin, true))
        .for('update');
    let admins = wasAdmin ? await lockAdmins() : null;
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!user || user.status === 'WITHDRAWN') throw AuthErrors.invalidToken();
    if (user.isAdmin) {
      admins ??= await lockAdmins();
      if (user.status === 'ACTIVE' && isLastActiveAdmin(admins, userId)) {
        throw WithdrawalErrors.lastAdmin();
      }
    }

    const suspension = withdrawnSuspensionOf(user, now);
    if (suspension) {
      await tx
        .insert(withdrawnSuspensions)
        .values(suspension)
        .onDuplicateKeyUpdate({
          set: { suspendedUntil: suspension.suspendedUntil, reason: suspension.reason },
        });
    }

    const imageKeys = (
      await tx
        .select({ key: inquiryImages.storageKey })
        .from(inquiryImages)
        .innerJoin(inquiries, eq(inquiries.id, inquiryImages.inquiryId))
        .where(eq(inquiries.userId, userId))
    ).map((row) => row.key);

    // 세션(리프레시 토큰은 CASCADE)·푸시 등록
    await tx.delete(devices).where(eq(devices.userId, userId));
    // 학습 기록 (문항·답안·기록 문항은 CASCADE)
    await tx.delete(studyRecords).where(eq(studyRecords.userId, userId));
    await tx.delete(studySessions).where(eq(studySessions.userId, userId));
    await tx.delete(wrongNotes).where(eq(wrongNotes.userId, userId));
    await tx.delete(userWordProgress).where(eq(userWordProgress.userId, userId));
    await tx.delete(dailyStudyStats).where(eq(dailyStudyStats.userId, userId));
    await tx.delete(dailyStudiedWords).where(eq(dailyStudiedWords.userId, userId));
    await tx.delete(userStreaks).where(eq(userStreaks.userId, userId));
    await tx.delete(wordFavorites).where(eq(wordFavorites.userId, userId));
    await tx.delete(practiceSessions).where(eq(practiceSessions.userId, userId));
    await tx.delete(challengeAttempts).where(eq(challengeAttempts.userId, userId));
    await tx.delete(morningCompletions).where(eq(morningCompletions.userId, userId));
    // XP·랭킹·보상
    await tx.delete(xpLedger).where(eq(xpLedger.userId, userId));
    await tx.delete(rankingSnapshots).where(eq(rankingSnapshots.userId, userId));
    await tx.delete(rankingSeasonExclusions).where(eq(rankingSeasonExclusions.userId, userId));
    await tx.delete(suspiciousFlags).where(eq(suspiciousFlags.userId, userId));
    await tx.delete(userBadges).where(eq(userBadges.userId, userId));
    await tx.delete(userMissions).where(eq(userMissions.userId, userId));
    await tx
      .delete(battleDailyPairs)
      .where(or(eq(battleDailyPairs.userId, userId), eq(battleDailyPairs.opponentId, userId)));
    // 관계·알림·약관·문의 (문의 이미지 행은 CASCADE, 파일은 커밋 뒤)
    await tx
      .delete(friendRequests)
      .where(or(eq(friendRequests.requesterId, userId), eq(friendRequests.receiverId, userId)));
    await tx
      .delete(friendships)
      .where(or(eq(friendships.userId, userId), eq(friendships.friendId, userId)));
    await tx.delete(blocks).where(or(eq(blocks.blockerId, userId), eq(blocks.blockedId, userId)));
    await tx.delete(notifications).where(eq(notifications.userId, userId));
    await tx.delete(notificationSettings).where(eq(notificationSettings.userId, userId));
    await tx.delete(noticeReads).where(eq(noticeReads.userId, userId));
    await tx.delete(userAgreements).where(eq(userAgreements.userId, userId));
    await tx.delete(inquiries).where(eq(inquiries.userId, userId));
    await tx.delete(teacherClasses).where(eq(teacherClasses.teacherId, userId));
    await this.removePacks(tx, userId);

    await tx.update(users).set(anonymizedUser(now)).where(eq(users.id, userId));
    return { user, imageKeys };
  }

  /**
   * 내 단어팩은 지운다. 다만 대결방에 쓰인 팩은 다른 사람의 대결 문항이 그 단어를 참조하므로
   * 사용자가 직접 지울 때처럼 소프트 삭제만 한다 (다른 사람이 복사한 팩은 따로 있는 사본이라 그대로 남는다)
   */
  private async removePacks(tx: Transaction, userId: string): Promise<void> {
    await tx.delete(packCopies).where(eq(packCopies.userId, userId));
    const owned = (
      await tx
        .select({ id: packs.id })
        .from(packs)
        .where(and(eq(packs.ownerUserId, userId), eq(packs.type, 'MINE')))
    ).map((row) => row.id);
    if (owned.length === 0) return;
    const used = new Set(
      (
        await tx
          .selectDistinct({ packId: battleRooms.packId })
          .from(battleRooms)
          .where(inArray(battleRooms.packId, owned))
      ).map((row) => row.packId),
    );
    const removable = owned.filter((id) => !used.has(id));
    const kept = owned.filter((id) => used.has(id));
    if (removable.length > 0) {
      await tx.delete(words).where(inArray(words.packId, removable));
      await tx.delete(packs).where(inArray(packs.id, removable));
    }
    if (kept.length > 0) {
      await tx
        .update(packs)
        .set({
          deletedAt: sql`COALESCE(${packs.deletedAt}, CURRENT_TIMESTAMP(3))`,
          shareCode: null,
          sharedAt: null,
        })
        .where(inArray(packs.id, kept));
    }
  }

  /** 들어가 있는 대결방과 진행하던 교사용 방에서 나간다 (진행 중이면 기존 나가기처럼 남은 문항은 0점) */
  private async leaveRooms(userId: string): Promise<void> {
    const joined = await this.db
      .select({ roomId: battleRoomParticipants.roomId })
      .from(battleRoomParticipants)
      .where(
        and(eq(battleRoomParticipants.userId, userId), eq(battleRoomParticipants.active, true)),
      );
    const hosted = await this.db
      .select({ roomId: battleRooms.id })
      .from(battleRooms)
      .where(
        and(
          eq(battleRooms.hostUserId, userId),
          eq(battleRooms.type, 'CLASS'),
          inArray(battleRooms.status, [...ACTIVE_ROOM_STATUS]),
        ),
      );
    const roomIds = new Set([...joined, ...hosted].map((row) => row.roomId));
    for (const roomId of roomIds) {
      await this.lobby
        .leave(userId, roomId)
        .catch((error: unknown) =>
          this.logger.warn(`탈퇴자 대결방 나가기 실패 (room ${roomId}): ${String(error)}`),
        );
    }
  }
}
