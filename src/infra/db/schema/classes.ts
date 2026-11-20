import { index, mysqlTable, primaryKey, tinyint, uniqueIndex } from 'drizzle-orm/mysql-core';
import { id, timestamps } from '../columns.js';
import { binaryUuid } from '../uuid.js';
import { users } from './users.js';

export const classes = mysqlTable(
  'classes',
  {
    id: id(),
    grade: tinyint('grade').notNull(),
    classNo: tinyint('class_no').notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [uniqueIndex('classes_grade_class_uq').on(t.grade, t.classNo)],
);

export const teacherClasses = mysqlTable(
  'teacher_classes',
  {
    teacherId: binaryUuid('teacher_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    classId: binaryUuid('class_id')
      .notNull()
      .references(() => classes.id, { onDelete: 'cascade' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.teacherId, t.classId] }),
    index('teacher_classes_class_idx').on(t.classId),
  ],
);

export type Class = typeof classes.$inferSelect;
