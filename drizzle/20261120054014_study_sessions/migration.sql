CREATE TABLE `study_session_questions` (
	`session_id` binary(16) NOT NULL,
	`idx` int NOT NULL,
	`word_id` binary(16) NOT NULL,
	`question_type` enum('EN_TO_KO_CHOICE','KO_TO_EN_CHOICE','EN_TO_KO_TYPING','KO_TO_EN_TYPING'),
	`prompt` varchar(600) NOT NULL,
	`derivatives` json NOT NULL,
	`choices` json,
	`answer_index` tinyint,
	`accepted_answers` json,
	`card` json,
	CONSTRAINT PRIMARY KEY(`session_id`,`idx`)
);
--> statement-breakpoint
CREATE TABLE `study_sessions` (
	`id` binary(16) PRIMARY KEY,
	`user_id` binary(16) NOT NULL,
	`source` enum('PACK','WRONG_NOTE','FAVORITE','REVIEW','RECORD_WRONG') NOT NULL,
	`pack_id` binary(16),
	`mode` enum('FLASHCARD','CHOICE','TYPING') NOT NULL,
	`direction` enum('EN_TO_KO','KO_TO_EN') NOT NULL,
	`shuffle` boolean NOT NULL,
	`status` enum('IN_PROGRESS','COMPLETED','ABANDONED') NOT NULL DEFAULT 'IN_PROGRESS',
	`total` int NOT NULL,
	`answered_count` int NOT NULL DEFAULT 0,
	`expires_at` datetime(3) NOT NULL,
	`completed_at` datetime(3),
	`active_key` varchar(64) GENERATED ALWAYS AS (IF(status = 'IN_PROGRESS', CONCAT(HEX(user_id), ':', IFNULL(HEX(pack_id), source)), NULL)) STORED,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `study_sessions_active_uq` UNIQUE INDEX(`active_key`)
);
--> statement-breakpoint
CREATE INDEX `study_sessions_user_status_idx` ON `study_sessions` (`user_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `study_sessions_expiry_idx` ON `study_sessions` (`status`,`expires_at`);--> statement-breakpoint
ALTER TABLE `study_session_questions` ADD CONSTRAINT `study_session_questions_session_id_study_sessions_id_fkey` FOREIGN KEY (`session_id`) REFERENCES `study_sessions`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `study_session_questions` ADD CONSTRAINT `study_session_questions_word_id_words_id_fkey` FOREIGN KEY (`word_id`) REFERENCES `words`(`id`);--> statement-breakpoint
ALTER TABLE `study_sessions` ADD CONSTRAINT `study_sessions_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `study_sessions` ADD CONSTRAINT `study_sessions_pack_id_packs_id_fkey` FOREIGN KEY (`pack_id`) REFERENCES `packs`(`id`);