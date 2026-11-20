CREATE TABLE `study_answers` (
	`session_id` binary(16) NOT NULL,
	`idx` int NOT NULL,
	`choice_index` tinyint,
	`typed_answer` varchar(200),
	`known` boolean,
	`correct` boolean,
	`counted` boolean NOT NULL,
	`elapsed_ms` int NOT NULL,
	`submitted_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT PRIMARY KEY(`session_id`,`idx`)
);
--> statement-breakpoint
CREATE TABLE `user_word_progress` (
	`user_id` binary(16) NOT NULL,
	`word_id` binary(16) NOT NULL,
	`pack_id` binary(16) NOT NULL,
	`memory_status` enum('NEW','LEARNING','MEMORIZED') NOT NULL,
	`correct_streak` int NOT NULL DEFAULT 0,
	`last_correct_session_id` binary(16),
	`total_correct` int NOT NULL DEFAULT 0,
	`total_wrong` int NOT NULL DEFAULT 0,
	`last_studied_at` datetime(3) NOT NULL,
	CONSTRAINT PRIMARY KEY(`user_id`,`word_id`)
);
--> statement-breakpoint
CREATE TABLE `wrong_notes` (
	`id` binary(16) PRIMARY KEY,
	`user_id` binary(16) NOT NULL,
	`word_id` binary(16) NOT NULL,
	`pack_id` binary(16) NOT NULL,
	`question_type` enum('EN_TO_KO_CHOICE','KO_TO_EN_CHOICE','EN_TO_KO_TYPING','KO_TO_EN_TYPING') NOT NULL,
	`source` enum('STUDY','BATTLE','MORNING') NOT NULL,
	`status` enum('ACTIVE','GRADUATED') NOT NULL DEFAULT 'ACTIVE',
	`wrong_count` int NOT NULL DEFAULT 1,
	`consecutive_correct` int NOT NULL DEFAULT 0,
	`last_session_id` binary(16),
	`first_wrong_at` datetime(3) NOT NULL,
	`last_wrong_at` datetime(3) NOT NULL,
	`graduated_at` datetime(3),
	CONSTRAINT `wrong_notes_word_type_uq` UNIQUE INDEX(`user_id`,`word_id`,`question_type`)
);
--> statement-breakpoint
CREATE INDEX `user_word_progress_pack_idx` ON `user_word_progress` (`user_id`,`pack_id`,`memory_status`);--> statement-breakpoint
CREATE INDEX `wrong_notes_recent_idx` ON `wrong_notes` (`user_id`,`status`,`last_wrong_at`,`id`);--> statement-breakpoint
CREATE INDEX `wrong_notes_count_idx` ON `wrong_notes` (`user_id`,`status`,`wrong_count`,`id`);--> statement-breakpoint
ALTER TABLE `study_answers` ADD CONSTRAINT `study_answers_session_id_study_sessions_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `study_sessions`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `user_word_progress` ADD CONSTRAINT `user_word_progress_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `user_word_progress` ADD CONSTRAINT `user_word_progress_word_id_words_id_fkey` FOREIGN KEY (`word_id`) REFERENCES `words`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `wrong_notes` ADD CONSTRAINT `wrong_notes_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `wrong_notes` ADD CONSTRAINT `wrong_notes_word_id_words_id_fkey` FOREIGN KEY (`word_id`) REFERENCES `words`(`id`) ON DELETE CASCADE;