import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { AuthErrors } from '../../common/auth/auth-errors.js';
import { type Database, DB } from '../../infra/db/db.module.js';
import { users } from '../../infra/db/schema/index.js';
import { type Me, toMe } from './me.schema.js';
import { TeacherClassService } from './teacher-class.service.js';

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
}
