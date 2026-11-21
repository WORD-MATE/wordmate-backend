CREATE TABLE `ranking_seasons` (
	`id` binary(16) PRIMARY KEY,
	`period` enum('WEEKLY','MONTHLY') NOT NULL,
	`period_key` varchar(10) NOT NULL,
	`starts_on` date NOT NULL,
	`ends_on` date NOT NULL,
	`status` enum('CLOSED_PENDING','CONFIRMED','FAILED') NOT NULL DEFAULT 'CLOSED_PENDING',
	`attempts` int NOT NULL DEFAULT 0,
	`last_error` varchar(500),
	`confirmed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `ranking_seasons_period_uq` UNIQUE INDEX(`period`,`period_key`)
);
--> statement-breakpoint
CREATE TABLE `ranking_snapshots` (
	`season_id` binary(16) NOT NULL,
	`scope` varchar(32) NOT NULL,
	`user_id` binary(16) NOT NULL,
	`rank` int NOT NULL,
	`xp` int NOT NULL,
	`listed` boolean NOT NULL,
	CONSTRAINT PRIMARY KEY(`season_id`,`scope`,`user_id`)
);
--> statement-breakpoint
CREATE INDEX `ranking_snapshots_user_idx` ON `ranking_snapshots` (`user_id`,`season_id`);--> statement-breakpoint
ALTER TABLE `ranking_snapshots` ADD CONSTRAINT `ranking_snapshots_season_id_ranking_seasons_id_fkey` FOREIGN KEY (`season_id`) REFERENCES `ranking_seasons`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `ranking_snapshots` ADD CONSTRAINT `ranking_snapshots_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE;