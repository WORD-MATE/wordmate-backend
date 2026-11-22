CREATE TABLE `morning_completions` (
	`user_id` binary(16) NOT NULL,
	`sentence_id` binary(16) NOT NULL,
	`correct_count` int NOT NULL,
	`total` int NOT NULL,
	`xp_granted` int NOT NULL,
	`completed_at` datetime(3) NOT NULL,
	CONSTRAINT PRIMARY KEY(`user_id`,`sentence_id`)
);
--> statement-breakpoint
CREATE TABLE `morning_keywords` (
	`sentence_id` binary(16) NOT NULL,
	`idx` int NOT NULL,
	`english` varchar(50) NOT NULL,
	`meanings` json NOT NULL,
	`example` varchar(500),
	`highlight_start` int NOT NULL,
	`highlight_end` int NOT NULL,
	CONSTRAINT PRIMARY KEY(`sentence_id`,`idx`)
);
--> statement-breakpoint
CREATE TABLE `morning_quizzes` (
	`sentence_id` binary(16) NOT NULL,
	`idx` int NOT NULL,
	`type` enum('FILL_BLANK','MEANING','QUESTION') NOT NULL,
	`question` varchar(500) NOT NULL,
	`choices` json,
	`answers` json NOT NULL,
	`explanation` varchar(500),
	CONSTRAINT PRIMARY KEY(`sentence_id`,`idx`)
);
--> statement-breakpoint
CREATE TABLE `morning_sentences` (
	`id` binary(16) PRIMARY KEY,
	`publish_date` date NOT NULL,
	`status` enum('PENDING_REVIEW','SCHEDULED','PUBLISHED') NOT NULL DEFAULT 'PENDING_REVIEW',
	`sentence` varchar(500) NOT NULL,
	`translation` varchar(500) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `publish_date_unique` UNIQUE INDEX(`publish_date`)
);
--> statement-breakpoint
CREATE INDEX `morning_completions_user_idx` ON `morning_completions` (`user_id`,`completed_at`);--> statement-breakpoint
CREATE INDEX `morning_sentences_status_idx` ON `morning_sentences` (`status`,`publish_date`);--> statement-breakpoint
ALTER TABLE `morning_completions` ADD CONSTRAINT `morning_completions_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `morning_completions` ADD CONSTRAINT `morning_completions_sentence_id_morning_sentences_id_fkey` FOREIGN KEY (`sentence_id`) REFERENCES `morning_sentences`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `morning_keywords` ADD CONSTRAINT `morning_keywords_sentence_id_morning_sentences_id_fkey` FOREIGN KEY (`sentence_id`) REFERENCES `morning_sentences`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `morning_quizzes` ADD CONSTRAINT `morning_quizzes_sentence_id_morning_sentences_id_fkey` FOREIGN KEY (`sentence_id`) REFERENCES `morning_sentences`(`id`) ON DELETE CASCADE;