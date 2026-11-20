CREATE TABLE `audit_logs` (
	`id` binary(16) PRIMARY KEY,
	`actor_id` binary(16),
	`action` varchar(50) NOT NULL,
	`target_type` varchar(30) NOT NULL,
	`target_id` varchar(64),
	`detail` json NOT NULL,
	`ip` varchar(45),
	`user_agent` varchar(255),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3))
);
--> statement-breakpoint
CREATE TABLE `classes` (
	`id` binary(16) PRIMARY KEY,
	`grade` tinyint NOT NULL,
	`class_no` tinyint NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `classes_grade_class_uq` UNIQUE INDEX(`grade`,`class_no`)
);
--> statement-breakpoint
CREATE TABLE `teacher_classes` (
	`teacher_id` binary(16) NOT NULL,
	`class_id` binary(16) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT PRIMARY KEY(`teacher_id`,`class_id`)
);
--> statement-breakpoint
CREATE INDEX `audit_logs_actor_idx` ON `audit_logs` (`actor_id`,`id`);--> statement-breakpoint
CREATE INDEX `audit_logs_target_idx` ON `audit_logs` (`target_id`,`id`);--> statement-breakpoint
CREATE INDEX `audit_logs_action_idx` ON `audit_logs` (`action`,`id`);--> statement-breakpoint
CREATE INDEX `audit_logs_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `teacher_classes_class_idx` ON `teacher_classes` (`class_id`);--> statement-breakpoint
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_actor_id_users_id_fkey` FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `teacher_classes` ADD CONSTRAINT `teacher_classes_teacher_id_users_id_fkey` FOREIGN KEY (`teacher_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `teacher_classes` ADD CONSTRAINT `teacher_classes_class_id_classes_id_fkey` FOREIGN KEY (`class_id`) REFERENCES `classes`(`id`) ON DELETE CASCADE;--> statement-breakpoint
INSERT INTO `classes` (`id`, `grade`, `class_no`) VALUES
  (UUID_TO_BIN('01a1f196-8848-7453-88e5-05b9e8b3a642'), 1, 1),
  (UUID_TO_BIN('01a1f196-884b-70aa-88d0-ac4977874903'), 1, 2),
  (UUID_TO_BIN('01a1f196-884b-70aa-88d0-b0374581f55b'), 1, 3),
  (UUID_TO_BIN('01a1f196-884b-70aa-88d0-b582627898b3'), 1, 4),
  (UUID_TO_BIN('01a1f196-884b-70aa-88d0-b9e134c2079c'), 2, 1),
  (UUID_TO_BIN('01a1f196-884b-70aa-88d0-be4eab34dbe7'), 2, 2),
  (UUID_TO_BIN('01a1f196-884b-70aa-88d0-c35436afd718'), 2, 3),
  (UUID_TO_BIN('01a1f196-884b-70aa-88d0-c4564ed6ee3f'), 2, 4),
  (UUID_TO_BIN('01a1f196-884b-70aa-88d0-c907bb044871'), 3, 1),
  (UUID_TO_BIN('01a1f196-884b-70aa-88d0-cde1f2bd25be'), 3, 2),
  (UUID_TO_BIN('01a1f196-884b-70aa-88d0-d311c2dfbc5d'), 3, 3),
  (UUID_TO_BIN('01a1f196-884b-70aa-88d0-d569213b5525'), 3, 4);
