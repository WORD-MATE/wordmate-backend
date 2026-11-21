import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AuthErrors } from '../../common/auth/auth-errors.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { users } from '../../infra/db/schema/index.js';
import { type Me, toMe } from './me.schema.js';
import { TeacherClassService } from './teacher-class.service.js';
import type { PrivacySettings } from './users.schemas.js';

@Injectable()
export class UsersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly teacherClasses: TeacherClassService,
  ) {}

  async me(userId: string): Promise<Me> {
    const [user] = await this.db.select().from(users).where(eq(users.id, userId));
    if (!user || user.status === 'WITHDRAWN') throw AuthErrors.invalidToken();
    return toMe(user, user.role === 'TEACHER' ? await this.teacherClasses.list(user.id) : []);
  }

  /** 랭킹 첫 진입 안내와 설정 화면이 같이 쓴다. 비공개여도 랭킹 점수는 쌓이고 목록에서만 빠진다 */
  async updatePrivacy(userId: string, rankingPublic: boolean): Promise<PrivacySettings> {
    await this.db
      .update(users)
      .set({ rankingPublic, rankingOnboarded: true })
      .where(eq(users.id, userId));
    return { rankingPublic, rankingOnboarded: true };
  }
}
