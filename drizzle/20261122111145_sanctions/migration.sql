CREATE TABLE `sanctions` (
	`id` binary(16) PRIMARY KEY,
	`user_id` binary(16) NOT NULL,
	`type` enum('WARNING','XP_REVOKE','SUSPEND','BAN') NOT NULL,
	`reason` varchar(200) NOT NULL,
	`suspended_until` datetime(3),
	`revoked_xp` int,
	`exclude_from_season` boolean NOT NULL DEFAULT false,
	`report_group_id` varchar(100),
	`admin_id` binary(16),
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT `sanctions_user_id_users_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `sanctions_admin_id_users_id_fkey` FOREIGN KEY (`admin_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `sanctions_user_idx` ON `sanctions` (`user_id`,`id`);