CREATE TABLE `report_group_history` (
	`id` binary(16) PRIMARY KEY,
	`group_id` binary(16) NOT NULL,
	`status` enum('RECEIVED','IN_REVIEW','RESOLVED') NOT NULL,
	`result` enum('DISMISSED','WARNING','SANCTIONED'),
	`memo` varchar(1000),
	`admin_id` binary(16),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3))
);
--> statement-breakpoint
CREATE TABLE `report_groups` (
	`id` binary(16) PRIMARY KEY,
	`target_type` enum('USER','PACK','WORD') NOT NULL,
	`target_id` binary(16) NOT NULL,
	`status` enum('RECEIVED','IN_REVIEW','RESOLVED') NOT NULL DEFAULT 'RECEIVED',
	`open_key` tinyint DEFAULT 1,
	`result` enum('DISMISSED','WARNING','SANCTIONED'),
	`memo` varchar(1000),
	`admin_id` binary(16),
	`resolved_at` datetime(3),
	`last_reported_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	`updated_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `report_groups_open_uq` UNIQUE INDEX(`target_type`,`target_id`,`open_key`)
);
--> statement-breakpoint
ALTER TABLE `reports` ADD `group_id` binary(16);--> statement-breakpoint
INSERT INTO `report_groups` (`id`, `target_type`, `target_id`, `status`, `open_key`, `last_reported_at`)
SELECT UUID_TO_BIN(UUID()), `target_type`, `target_id`, 'RECEIVED', 1, MAX(`created_at`) FROM `reports` GROUP BY `target_type`, `target_id`;--> statement-breakpoint
UPDATE `reports` r JOIN `report_groups` g ON g.`target_type` = r.`target_type` AND g.`target_id` = r.`target_id` SET r.`group_id` = g.`id`;--> statement-breakpoint
ALTER TABLE `reports` MODIFY `group_id` binary(16) NOT NULL;--> statement-breakpoint
CREATE INDEX `report_group_history_group_idx` ON `report_group_history` (`group_id`,`id`);--> statement-breakpoint
CREATE INDEX `report_groups_status_idx` ON `report_groups` (`status`,`last_reported_at`);--> statement-breakpoint
CREATE INDEX `reports_group_idx` ON `reports` (`group_id`,`id`);--> statement-breakpoint
ALTER TABLE `report_group_history` ADD CONSTRAINT `report_group_history_group_id_report_groups_id_fkey` FOREIGN KEY (`group_id`) REFERENCES `report_groups`(`id`) ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE `report_group_history` ADD CONSTRAINT `report_group_history_admin_id_users_id_fkey` FOREIGN KEY (`admin_id`) REFERENCES `users`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `report_groups` ADD CONSTRAINT `report_groups_admin_id_users_id_fkey` FOREIGN KEY (`admin_id`) REFERENCES `users`(`id`) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `reports` ADD CONSTRAINT `reports_group_id_report_groups_id_fkey` FOREIGN KEY (`group_id`) REFERENCES `report_groups`(`id`) ON DELETE CASCADE;