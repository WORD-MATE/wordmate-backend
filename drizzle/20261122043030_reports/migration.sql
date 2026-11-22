CREATE TABLE `reports` (
	`id` binary(16) PRIMARY KEY,
	`reporter_id` binary(16) NOT NULL,
	`target_type` enum('USER','PACK','WORD') NOT NULL,
	`target_id` binary(16) NOT NULL,
	`reason` enum('INAPPROPRIATE_CONTENT','OFFENSIVE_REACTION','CHEATING','OTHER') NOT NULL,
	`detail` varchar(200),
	`battle_id` binary(16),
	`status` enum('RECEIVED','IN_REVIEW','RESOLVED') NOT NULL DEFAULT 'RECEIVED',
	`report_date` char(10) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `reports_daily_uq` UNIQUE INDEX(`reporter_id`,`target_type`,`target_id`,`reason`,`report_date`),
	CONSTRAINT `reports_reporter_id_users_id_fkey` FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `reports_battle_id_battles_id_fkey` FOREIGN KEY (`battle_id`) REFERENCES `battles`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `reports_status_idx` ON `reports` (`status`,`id`);--> statement-breakpoint
CREATE INDEX `reports_target_idx` ON `reports` (`target_type`,`target_id`);