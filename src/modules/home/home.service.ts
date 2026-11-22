import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { AuthUser } from '../../common/auth/auth-user.js';
import type { StudySource } from '../../common/enums.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { studyRecords } from '../../infra/db/schema/index.js';
import { MissionsService } from '../missions/missions.service.js';
import { MorningService } from '../morning/morning.service.js';
import { PacksService } from '../packs/packs.service.js';
import { RankingQueryService } from '../ranking/ranking-query.service.js';
import { RecordsService } from '../records/records.service.js';
import { StudySessionsService } from '../study/study-sessions.service.js';
import type { Home } from './home.schemas.js';

export const RECOMMENDED_PACK_COUNT = 5;

const SOURCE_NAMES: Record<Exclude<StudySource, 'PACK'>, string> = {
  FAVORITE: '즐겨찾기',
  WRONG_NOTE: '오답노트',
  RECORD_WRONG: '틀린 단어',
  REVIEW: '오늘의 복습',
};

@Injectable()
export class HomeService {
  private readonly logger = new Logger(HomeService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly sessions: StudySessionsService,
    private readonly records: RecordsService,
    private readonly ranking: RankingQueryService,
    private readonly packs: PacksService,
    private readonly morning: MorningService,
    private readonly missions: MissionsService,
  ) {}

  /** 칸마다 따로 불러 한 칸이 실패해도 나머지는 보여준다 (실패한 칸은 null, 추천 팩은 빈 배열) */
  async home(user: AuthUser): Promise<Home> {
    const [morning, review, continueStudy, streak, missions, myWeeklyRank, recommendedPacks] =
      await Promise.all([
        this.part('morning', () => this.morning.card(user)),
        this.part('review', async () => ({
          dueCount: (await this.sessions.reviewSummary(user)).dueCount,
        })),
        this.part('continueStudy', () => this.continueStudy(user)),
        this.part('streak', () => this.records.streak(user)),
        this.part('missions', async () =>
          user.role === 'STUDENT' ? this.missions.dailyCard(user) : null,
        ),
        this.part('myWeeklyRank', () => this.weeklyRank(user)),
        this.part('recommendedPacks', () => this.recommendedPacks(user)),
      ]);
    return {
      morning,
      review,
      continueStudy,
      streak,
      missions,
      myWeeklyRank,
      recommendedPacks: recommendedPacks ?? [],
    };
  }

  private async part<T>(name: string, load: () => Promise<T>): Promise<T | null> {
    try {
      return await load();
    } catch (error) {
      this.logger.error(`홈 ${name} 불러오기 실패: ${String(error)}`);
      return null;
    }
  }

  private async continueStudy(user: AuthUser): Promise<Home['continueStudy']> {
    const current = await this.sessions.current(user);
    if (!current) return null;
    return {
      sessionId: current.sessionId,
      source: current.source,
      packId: current.pack?.packId ?? null,
      packName:
        current.source === 'PACK' ? (current.pack?.name ?? '') : SOURCE_NAMES[current.source],
      answered: current.answered,
      total: current.total,
    };
  }

  private async weeklyRank(user: AuthUser): Promise<Home['myWeeklyRank']> {
    if (user.role !== 'STUDENT') return null;
    const mine = await this.ranking.me(user, { period: 'WEEKLY', scope: 'SCHOOL' });
    return { rank: mine.rank, topPercent: mine.topPercent, xp: mine.xp, change: mine.change };
  }

  private async recommendedPacks(user: AuthUser): Promise<Home['recommendedPacks']> {
    const [studied] = await this.db
      .select({ id: studyRecords.id })
      .from(studyRecords)
      .where(eq(studyRecords.userId, user.userId))
      .limit(1);
    if (studied) return [];
    const page = await this.packs.list(user, {
      type: 'DEFAULT',
      sort: 'RECOMMENDED',
      size: RECOMMENDED_PACK_COUNT,
    });
    return page.items;
  }
}
