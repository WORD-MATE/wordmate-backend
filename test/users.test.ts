import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/mysql2';
import { createPool, type Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/infra/db/schema/index.js';
import { newId } from '../src/infra/db/uuid.js';

describe('users 테이블', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool({ uri: process.env.DATABASE_URL, timezone: 'Z' });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('UUIDv7 PK와 기본값으로 저장하고 같은 값으로 읽는다', async () => {
    const db = drizzle({ client: pool });
    const id = newId();
    await db.insert(users).values({ id, datagsmId: 'dg-1', name: '홍길동', role: 'STUDENT' });

    const [row] = await db.select().from(users).where(eq(users.id, id));

    expect(row).toMatchObject({
      id,
      datagsmId: 'dg-1',
      isAdmin: false,
      status: 'ACTIVE',
      avatarId: 'default',
      totalXp: 0,
      suspendedUntil: null,
    });
    expect(row?.createdAt).toBeInstanceOf(Date);
  });
});
