CREATE TABLE `daily_studied_words` (
	`user_id` binary(16) NOT NULL,
	`date` date NOT NULL,
	`word_id` binary(16) NOT NULL,
	CONSTRAINT PRIMARY KEY(`user_id`,`date`,`word_id`)
);
--> statement-breakpoint
CREATE TABLE `daily_study_stats` (
	`user_id` binary(16) NOT NULL,
	`date` date NOT NULL,
	`solved_count` int NOT NULL DEFAULT 0,
	`graded_count` int NOT NULL DEFAULT 0,
	`correct_count` int NOT NULL DEFAULT 0,
	`sessions_completed` int NOT NULL DEFAULT 0,
	`xp_study` int NOT NULL DEFAULT 0,
	CONSTRAINT PRIMARY KEY(`user_id`,`date`)
);
--> statement-breakpoint
CREATE TABLE `study_record_items` (
	`record_id` binary(16) NOT NULL,
	`idx` int NOT NULL,
	`word_id` binary(16) NOT NULL,
	`english` varchar(50) NOT NULL,
	`meanings` json NOT NULL,
	`question_type` enum('EN_TO_KO_CHOICE','KO_TO_EN_CHOICE','EN_TO_KO_TYPING','KO_TO_EN_TYPING'),
	`correct` boolean,
	`known` boolean,
	`user_answer` varchar(200),
	CONSTRAINT PRIMARY KEY(`record_id`,`idx`)
);
--> statement-breakpoint
CREATE TABLE `study_records` (
	`id` binary(16) PRIMARY KEY,
	`user_id` binary(16) NOT NULL,
	`session_id` binary(16),
	`source` enum('PACK','WRONG_NOTE','FAVORITE','REVIEW','RECORD_WRONG') NOT NULL,
	`pack_id` binary(16),
	`mode` enum('FLASHCARD','CHOICE','TYPING') NOT NULL,
	`direction` enum('EN_TO_KO','KO_TO_EN') NOT NULL,
	`reason` enum('FINISHED','QUIT') NOT NULL,
	`correct_count` int NOT NULL,
	`wrong_count` int NOT NULL,
	`known_count` int,
	`unknown_count` int,
	`accuracy` decimal(4,1),
	`xp_earned` int NOT NULL,
	`pack_complete_bonus` boolean NOT NULL,
	`completed_at` datetime(3) NOT NULL,
	`completed_date` date NOT NULL,
	CONSTRAINT `study_records_session_uq` UNIQUE INDEX(`session_id`)
);
--> statement-breakpoint
CREATE TABLE `user_streaks` (
	`user_id` binary(16) NOT NULL,
	`kind` enum('STUDY','MORNING') NOT NULL,
	`current` int NOT NULL DEFAULT 0,
	`best` int NOT NULL DEFAULT 0,
	`last_date` date,
	CONSTRAINT PRIMARY KEY(`user_id`,`kind`)
);
--> statement-breakpoint
CREATE TABLE `xp_ledger` (
	`id` binary(16) PRIMARY KEY,
	`user_id` binary(16) NOT NULL,
	`source` enum('STUDY','PACK_COMPLETE','BATTLE','MORNING','MISSION','CHALLENGE','WRONG_NOTE_REVIEW','ADMIN_ADJUST') NOT NULL,
	`ref_key` varchar(100) NOT NULL,
	`amount` int NOT NULL,
	`blocked_reason` enum('DAILY_CAP','REPEAT_LIMIT','FORFEIT','TOO_FAST','NOT_COMPLETED'),
	`date` date NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `xp_ledger_ref_uq` UNIQUE INDEX(`user_id`,`source`,`ref_key`)
);
--> statement-breakpoint
ALTER TABLE `study_sessions` ADD `covers_pack` boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `study_record_items_word_idx` ON `study_record_items` (`word_id`);--> statement-breakpoint
CREATE INDEX `study_records_user_completed_idx` ON `study_records` (`user_id`,`completed_at`,`id`);--> statement-breakpoint
CREATE INDEX `study_records_user_date_idx` ON `study_records` (`user_id`,`completed_date`);--> statement-breakpoint
CREATE INDEX `xp_ledger_user_date_idx` ON `xp_ledger` (`user_id`,`date`);--> statement-breakpoint
ALTER TABLE `daily_studied_words` ADD CONSTRAINT `daily_studied_words_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `daily_study_stats` ADD CONSTRAINT `daily_study_stats_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `study_record_items` ADD CONSTRAINT `study_record_items_record_id_study_records_id_fkey` FOREIGN KEY (`record_id`) REFERENCES `study_records`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `study_records` ADD CONSTRAINT `study_records_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `study_records` ADD CONSTRAINT `study_records_session_id_study_sessions_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `study_sessions`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `study_records` ADD CONSTRAINT `study_records_pack_id_packs_id_fkey` FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`);--> statement-breakpoint
ALTER TABLE `user_streaks` ADD CONSTRAINT `user_streaks_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `xp_ledger` ADD CONSTRAINT `xp_ledger_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;