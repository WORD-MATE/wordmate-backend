import { sql } from 'drizzle-orm';
import { datetime } from 'drizzle-orm/mysql-core';
import { binaryUuid, newId } from './uuid.js';

export const id = () => binaryUuid('id').primaryKey().$defaultFn(newId);

export const timestamps = {
  createdAt: datetime('created_at', { mode: 'date', fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: datetime('updated_at', { mode: 'date', fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3)`)
    .$onUpdate(() => new Date()),
};

export const softDelete = {
  deletedAt: datetime('deleted_at', { mode: 'date', fsp: 3 }),
};
