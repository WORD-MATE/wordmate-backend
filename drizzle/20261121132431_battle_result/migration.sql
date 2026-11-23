CREATE TABLE `battle_daily_pairs` (
	`date` date NOT NULL,
	`user_id` binary(16) NOT NULL,
	`opponent_id` binary(16) NOT NULL,
	`count` int NOT NULL,
	CONSTRAINT PRIMARY KEY(`date`,`user_id`,`opponent_id`)
);
--> statement-breakpoint
CREATE TABLE `battle_results` (
	`battle_id` binary(16) NOT NULL,
	`user_id` binary(16) NOT NULL,
	`rank` int,
	`score` int NOT NULL,
	`correct_count` int NOT NULL,
	`total_time_ms` int NOT NULL,
	`outcome` enum('WIN','DRAW','LOSE','LEFT','WIN_BY_FORFEIT') NOT NULL,
	`xp_earned` int NOT NULL,
	`xp_blocked_reason` enum('DAILY_CAP','REPEAT_LIMIT','FORFEIT','TOO_FAST','NOT_COMPLETED'),
	`finished_at` datetime(3) NOT NULL,
	CONSTRAINT PRIMARY KEY(`battle_id`,`user_id`)
);
--> statement-breakpoint
CREATE INDEX `battle_results_history_idx` ON `battle_results` (`user_id`,`finished_at`,`battle_id`);--> statement-breakpoint
ALTER TABLE `battle_daily_pairs` ADD CONSTRAINT `battle_daily_pairs_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `battle_daily_pairs` ADD CONSTRAINT `battle_daily_pairs_opponent_id_users_id_fkey` FOREIGN KEY (`opponent_id`) REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `battle_results` ADD CONSTRAINT `battle_results_battle_id_battles_id_fkey` FOREIGN KEY (`battle_id`) REFERENCES `battles`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `battle_results` ADD CONSTRAINT `battle_results_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`);