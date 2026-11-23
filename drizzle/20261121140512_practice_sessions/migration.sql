CREATE TABLE `practice_sessions` (
	`id` binary(16) PRIMARY KEY,
	`user_id` binary(16) NOT NULL,
	`pack_id` binary(16) NOT NULL,
	`question_type` enum('EN_TO_KO_CHOICE','KO_TO_EN_CHOICE','EN_TO_KO_TYPING','KO_TO_EN_TYPING') NOT NULL,
	`question_count` int NOT NULL,
	`time_limit_sec` int NOT NULL,
	`questions` json NOT NULL,
	`score` int,
	`correct_count` int,
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `practice_sessions_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE INDEX `practice_sessions_created_idx` ON `practice_sessions` (`created_at`);