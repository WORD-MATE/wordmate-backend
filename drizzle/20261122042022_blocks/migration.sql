CREATE TABLE `blocks` (
	`blocker_id` binary(16) NOT NULL,
	`blocked_id` binary(16) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3)),
	CONSTRAINT PRIMARY KEY(`blocker_id`,`blocked_id`),
	CONSTRAINT `blocks_blocker_id_users_id_fkey` FOREIGN KEY (`blocker_id`) REFERENCES `users`(`id`) ON DELETE CASCADE,
	CONSTRAINT `blocks_blocked_id_users_id_fkey` FOREIGN KEY (`blocked_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `blocks_blocked_idx` ON `blocks` (`blocked_id`);