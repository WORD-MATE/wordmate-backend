CREATE TABLE `challenge_attempts` (
	`id` binary(16) PRIMARY KEY,
	`user_id` binary(16) NOT NULL,
	`date` date NOT NULL,
	`started_at` datetime(3) NOT NULL,
	`completed_at` datetime(3),
	`score` int,
	`correct_count` int,
	`answers` json,
	`xp_earned` int,
	`xp_blocked_reason` enum('DAILY_CAP','REPEAT_LIMIT','FORFEIT','TOO_FAST','NOT_COMPLETED'),
	CONSTRAINT `challenge_attempts_user_date_uq` UNIQUE INDEX(`user_id`,`date`)
);
--> statement-breakpoint
CREATE TABLE `daily_challenges` (
	`date` date PRIMARY KEY,
	`question_type` enum('EN_TO_KO_CHOICE','KO_TO_EN_CHOICE','EN_TO_KO_TYPING','KO_TO_EN_TYPING') NOT NULL,
	`question_count` int NOT NULL,
	`time_limit_sec` int NOT NULL,
	`questions` json NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3))
);
--> statement-breakpoint
ALTER TABLE `challenge_attempts` ADD CONSTRAINT `challenge_attempts_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `challenge_attempts` ADD CONSTRAINT `challenge_attempts_date_daily_challenges_date_fkey` FOREIGN KEY (`date`) REFERENCES `daily_challenges`(`date`);